/**
 * Modern Living Hub — Pinterest Integration Frontend
 * Handles OAuth handoff, session token, board listing, pin creation,
 * and board creation via the server-side backend API.
 *
 * Cross-site architecture:
 *   1. Backend redirects to this page with ?pinterest_connected=1&handoff=<CODE>
 *   2. Frontend POSTs handoff code to /api/pinterest/complete
 *   3. Backend returns a bearer session_token
 *   4. All subsequent API calls use Authorization: Bearer <session_token>
 *
 * The backend URL is configured in each page via:
 *   window.BACKEND_URL = 'https://your-backend-domain.com';
 */

(function () {
    'use strict';

    // ─── Configuration ───
    var BACKEND = (window.BACKEND_URL || '').replace(/\/+$/, '');
    var SESSION_TOKEN_KEY = 'mlh_session_token';
    var sessionToken = localStorage.getItem(SESSION_TOKEN_KEY) || null;

    // ─── Backend availability helpers ───
    function isBackendConfigured() {
        return Boolean(BACKEND) && !BACKEND.includes('YOUR-BACKEND');
    }

    function showConfigError(msg, elem) {
        if (elem) {
            elem.innerHTML = '⚠️ ' + msg;
            elem.style.color = 'var(--color-error)';
        }
    }

    // ─── Auth headers helper ───
    function authHeaders(extra) {
        var headers = Object.assign({}, extra || {});
        if (sessionToken) {
            headers['Authorization'] = 'Bearer ' + sessionToken;
        }
        return headers;
    }

    function delay(ms) {
        return new Promise(function (resolve) { setTimeout(resolve, ms); });
    }

    // ─── DOM references ───
    var connectBtn = document.getElementById('connect-pinterest-btn');
    var statusBanner = document.getElementById('pinterest-status');
    var homeDisconnectBtn = document.getElementById('disconnect-pinterest-btn');

    var connectedState = document.getElementById('connected-state');
    var disconnectedState = document.getElementById('disconnected-state');

    var boardSelect = document.getElementById('board-select');
    var createBoardForm = document.getElementById('create-board-form');
    var createPinForm = document.getElementById('create-pin-form');

    var boardResult = document.getElementById('board-result');
    var pinResult = document.getElementById('pin-result');
    var disconnectError = document.getElementById('disconnect-error');

    // ─── Update Connect Pinterest links to point to backend OAuth ───
    function updateConnectLinks() {
        var authUrl = isBackendConfigured() ? BACKEND + '/auth/pinterest' : '#';
        document.querySelectorAll('a.btn-pinterest').forEach(function (link) {
            if (link.id !== 'disconnect-pinterest-btn') {
                link.href = authUrl;
            }
        });

        if (!isBackendConfigured()) {
            document.querySelectorAll('a.btn-pinterest').forEach(function (link) {
                link.style.pointerEvents = 'none';
                link.style.opacity = '0.5';
            });
        }
    }

    // ─── Complete OAuth handoff (one-time code → bearer session token) ───
    async function completeHandoff(code) {
        try {
            var res = await fetch(BACKEND + '/api/pinterest/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ handoff: code })
            });
            var data = await res.json();
            if (data.connected && data.session_token) {
                sessionToken = data.session_token;
                localStorage.setItem(SESSION_TOKEN_KEY, sessionToken);
                showConnectedUI();
                return true;
            } else {
                showError(disconnectError, data.error || 'Could not complete Pinterest connection.');
                showDisconnectedUI();
                return false;
            }
        } catch (e) {
            showError(disconnectError, 'Could not reach the server to complete connection.');
            showDisconnectedUI();
            return false;
        }
    }

    // ─── Handle OAuth return params ───
    async function handleUrlParams() {
        var params = new URLSearchParams(window.location.search);
        var handoff = params.get('handoff');
        var error = params.get('pinterest_error');

        if (params.get('pinterest_connected') === '1' && handoff) {
            // Clean URL immediately
            window.history.replaceState({}, '', window.location.pathname);
            // Complete the one-time handoff → get bearer session token
            await completeHandoff(handoff);
            return;
        }

        if (params.get('pinterest_connected') === '1') {
            window.history.replaceState({}, '', window.location.pathname);
            // Legacy: no handoff code, try existing session token
        }

        if (error) {
            window.history.replaceState({}, '', window.location.pathname);
            showError(disconnectError, decodeURIComponent(error));
        }
    }

    // ─── Check connection status on page load ───
    async function checkStatus() {
        if (!isBackendConfigured()) {
            showConfigError('Backend not configured. Set window.BACKEND_URL in the page source.', disconnectError || statusBanner);
            showDisconnectedUI();
            return;
        }
        try {
            var res = await fetch(BACKEND + '/api/pinterest/status', {
                credentials: 'include',
                headers: authHeaders()
            });
            var data = await res.json();
            if (data.connected) {
                showConnectedUI();
            } else if (data.needs_reauth) {
                // Token lacks required scopes — show clear reconnect message
                sessionToken = null;
                localStorage.removeItem(SESSION_TOKEN_KEY);
                showDisconnectedUI();
                if (disconnectError) {
                    disconnectError.textContent = '⚠️ Your Pinterest token is missing required permissions. Please disconnect and reconnect Pinterest.';
                    disconnectError.style.display = 'block';
                }
            } else {
                // Session token expired or invalid — clear it
                if (sessionToken) {
                    sessionToken = null;
                    localStorage.removeItem(SESSION_TOKEN_KEY);
                }
                showDisconnectedUI();
            }
        } catch {
            showDisconnectedUI();
        }
    }

    function showConnectedUI() {
        if (connectBtn) {
            connectBtn.textContent = '✅ Connected';
            connectBtn.href = '#';
            connectBtn.style.pointerEvents = 'none';
            connectBtn.style.opacity = '0.6';
        }
        if (statusBanner) statusBanner.style.display = 'block';
        if (connectedState) connectedState.style.display = 'block';
        if (disconnectedState) disconnectedState.style.display = 'none';
        loadBoards();
    }

    function showDisconnectedUI() {
        if (connectBtn) {
            connectBtn.textContent = '📌 Connect Pinterest';
            connectBtn.href = isBackendConfigured() ? BACKEND + '/auth/pinterest' : '#';
            connectBtn.style.pointerEvents = isBackendConfigured() ? '' : 'none';
            connectBtn.style.opacity = isBackendConfigured() ? '' : '0.5';
        }
        if (statusBanner) statusBanner.style.display = 'none';
        if (connectedState) connectedState.style.display = 'none';
        if (disconnectedState) disconnectedState.style.display = 'block';
    }

    // ─── Load user's Pinterest boards ───
    async function loadBoards() {
        if (!boardSelect) return;
        if (!isBackendConfigured()) {
            boardSelect.innerHTML = '<option value="">Backend not configured</option>';
            return;
        }
        try {
            var res = await fetch(BACKEND + '/api/pinterest/boards', {
                credentials: 'include',
                headers: authHeaders()
            });
            if (res.status === 401) {
                boardSelect.innerHTML = '<option value="">Not connected — reconnect</option>';
                return;
            }
            var data = await res.json();
            if (!data.boards || !data.boards.length) {
                boardSelect.innerHTML = '<option value="">No boards found — create one below</option>';
                return;
            }
            boardSelect.innerHTML = '<option value="">Select a board</option>';
            data.boards.forEach(function (board) {
                var opt = document.createElement('option');
                opt.value = board.id;
                opt.textContent = board.name + (board.description ? ' — ' + board.description : '');
                boardSelect.appendChild(opt);
            });
        } catch {
            boardSelect.innerHTML = '<option value="">Could not load boards</option>';
        }
    }

    // ─── Create Board ───
    if (createBoardForm) {
        createBoardForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!isBackendConfigured()) {
                if (boardResult) {
                    boardResult.textContent = '❌ Backend not configured.';
                    boardResult.style.color = 'var(--color-error)';
                }
                return;
            }
            var name = document.getElementById('board-name').value.trim();
            var description = document.getElementById('board-description').value.trim();
            if (!name) return;

            boardResult.textContent = 'Creating board…';
            boardResult.style.color = 'var(--color-text-light)';

            try {
                var res = await fetch(BACKEND + '/api/pinterest/boards', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    credentials: 'include',
                    body: JSON.stringify({ name: name, description: description })
                });
                var data = await res.json();
                if (!res.ok) {
                    boardResult.textContent = '❌ ' + (data.error || 'Failed to create board.');
                    boardResult.style.color = 'var(--color-error)';
                    return;
                }
                boardResult.innerHTML = '✅ Board created: <strong>' + escapeHtml(data.board.name) + '</strong>';
                boardResult.style.color = 'var(--color-success)';
                createBoardForm.reset();
                // Refresh board dropdown with retry for Pinterest eventual consistency
                await delay(800);
                await loadBoards();
                // Auto-select the newly created board if present
                if (boardSelect) {
                    var newId = data.board.id;
                    var opts = boardSelect.options;
                    for (var i = 0; i < opts.length; i++) {
                        if (opts[i].value === newId) {
                            boardSelect.selectedIndex = i;
                            break;
                        }
                    }
                }
            } catch {
                boardResult.textContent = '❌ Could not reach the server. Please try again.';
                boardResult.style.color = 'var(--color-error)';
            }
        });
    }

    // ─── Create Pin ───
    if (createPinForm) {
        createPinForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!isBackendConfigured()) {
                if (pinResult) {
                    pinResult.textContent = '❌ Backend not configured.';
                    pinResult.style.color = 'var(--color-error)';
                }
                return;
            }
            var boardId = boardSelect ? boardSelect.value : '';
            var imageUrl = document.getElementById('pin-image-url').value.trim();
            var title = document.getElementById('pin-title').value.trim();
            var description = document.getElementById('pin-description').value.trim();
            var destinationUrl = document.getElementById('pin-destination-url').value.trim();

            if (!boardId) {
                pinResult.textContent = '❌ Please select a board.';
                pinResult.style.color = 'var(--color-error)';
                return;
            }
            if (!imageUrl || !title || !destinationUrl) {
                pinResult.textContent = '❌ Image URL, title, and destination URL are required.';
                pinResult.style.color = 'var(--color-error)';
                return;
            }

            pinResult.textContent = 'Publishing pin…';
            pinResult.style.color = 'var(--color-text-light)';

            try {
                var res = await fetch(BACKEND + '/api/pinterest/pins', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    credentials: 'include',
                    body: JSON.stringify({
                        board_id: boardId,
                        title: title,
                        description: description,
                        image_url: imageUrl,
                        destination_url: destinationUrl
                    })
                });
                var data = await res.json();
                if (!res.ok) {
                    pinResult.textContent = '❌ ' + (data.error || 'Failed to create pin.');
                    pinResult.style.color = 'var(--color-error)';
                    return;
                }
                pinResult.innerHTML = '✅ Pin published successfully! Pin ID: <strong>' + escapeHtml(data.pin.id) + '</strong>';
                pinResult.style.color = 'var(--color-success)';
                createPinForm.reset();
                loadBoards();
            } catch {
                pinResult.textContent = '❌ Could not reach the server. Please try again.';
                pinResult.style.color = 'var(--color-error)';
            }
        });
    }

    // ─── Disconnect ───
    async function disconnectPinterest() {
        if (!isBackendConfigured()) return;
        try {
            var res = await fetch(BACKEND + '/api/pinterest/disconnect', {
                method: 'POST',
                credentials: 'include',
                headers: authHeaders({ 'Content-Type': 'application/json' })
            });
            var data = await res.json();
            if (data.disconnected) {
                sessionToken = null;
                localStorage.removeItem(SESSION_TOKEN_KEY);
                showDisconnectedUI();
            }
        } catch {
            showError(disconnectError, 'Could not reach the server.');
        }
    }

    // ─── Disconnect button (both pages) ───
    if (homeDisconnectBtn) {
        homeDisconnectBtn.addEventListener('click', disconnectPinterest);
    }

    var disconnectBtnOnPage = document.getElementById('disconnect-pinterest-btn');
    if (disconnectBtnOnPage && disconnectBtnOnPage !== homeDisconnectBtn) {
        disconnectBtnOnPage.addEventListener('click', disconnectPinterest);
    }

    // ─── Helpers ───
    function showError(el, msg) {
        if (!el) return;
        el.textContent = '⚠️ ' + msg;
        el.style.display = 'block';
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    // ─── Init ───
    updateConnectLinks();
    handleUrlParams().then(function () {
        checkStatus();
    });
})();
