/**
 * Modern Living Hub — Pinterest Integration Frontend
 * Handles OAuth status, board listing, pin creation, and board creation
 * via the server-side backend API.
 *
 * The backend URL is configured in each page via:
 *   window.BACKEND_URL = 'https://your-backend-domain.com';
 * All Pinterest API calls (OAuth, status, boards, pins, disconnect)
 * use this single value.
 */

(function () {
    'use strict';

    // ─── Configuration ───
    const BACKEND = (window.BACKEND_URL || '').replace(/\/+$/, ''); // strip trailing slashes

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

    // ─── DOM references ───
    const connectBtn = document.getElementById('connect-pinterest-btn');
    const statusBanner = document.getElementById('pinterest-status');
    const homeDisconnectBtn = document.getElementById('disconnect-pinterest-btn');

    const connectedState = document.getElementById('connected-state');
    const disconnectedState = document.getElementById('disconnected-state');

    const boardSelect = document.getElementById('board-select');
    const createBoardForm = document.getElementById('create-board-form');
    const createPinForm = document.getElementById('create-pin-form');

    const boardResult = document.getElementById('board-result');
    const pinResult = document.getElementById('pin-result');
    const disconnectError = document.getElementById('disconnect-error');

    // ─── Update Connect Pinterest links to point to backend OAuth ───
    function updateConnectLinks() {
        const authUrl = isBackendConfigured() ? BACKEND + '/auth/pinterest' : '#';
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

    // ─── Handle OAuth return params ───
    function handleUrlParams() {
        const params = new URLSearchParams(window.location.search);
        if (params.get('pinterest_connected') === '1') {
            window.history.replaceState({}, '', window.location.pathname);
            showConnectedUI();
        }
        if (params.get('pinterest_error')) {
            const msg = params.get('pinterest_error');
            window.history.replaceState({}, '', window.location.pathname);
            showError(disconnectError, msg);
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
            const res = await fetch(`${BACKEND}/api/pinterest/status`, {
                credentials: 'include'
            });
            const data = await res.json();
            if (data.connected) {
                showConnectedUI();
            } else {
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
        boardSelect.innerHTML = '<option value="">Loading boards…</option>';
        try {
            const res = await fetch(`${BACKEND}/api/pinterest/boards`, {
                credentials: 'include'
            });
            const data = await res.json();
            if (!res.ok) {
                boardSelect.innerHTML = `<option value="">Error: ${escapeHtml(data.error)}</option>`;
                return;
            }
            if (data.boards.length === 0) {
                boardSelect.innerHTML = '<option value="">No boards found. Create one above.</option>';
                return;
            }
            boardSelect.innerHTML = '<option value="">Select a board…</option>';
            data.boards.forEach(function (board) {
                const opt = document.createElement('option');
                opt.value = board.id;
                opt.textContent = board.name;
                boardSelect.appendChild(opt);
            });
        } catch {
            boardSelect.innerHTML = '<option value="">Could not load boards — is the backend running?</option>';
        }
    }

    // ─── Disconnect Pinterest ───
    async function disconnectPinterest() {
        if (!isBackendConfigured()) {
            showError(disconnectError, 'Backend not configured.');
            return;
        }
        try {
            const res = await fetch(`${BACKEND}/api/pinterest/disconnect`, {
                method: 'POST',
                credentials: 'include'
            });
            const data = await res.json();
            if (data.disconnected) {
                showDisconnectedUI();
            } else {
                showError(disconnectError, 'Disconnect failed. Please try again.');
            }
        } catch {
            showError(disconnectError, 'Could not reach the server. Please try again.');
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
            const name = document.getElementById('board-name').value.trim();
            const description = document.getElementById('board-description').value.trim();
            if (!name) return;

            boardResult.textContent = 'Creating board…';
            boardResult.style.color = 'var(--color-text-light)';

            try {
                const res = await fetch(`${BACKEND}/api/pinterest/boards`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({ name: name, description: description })
                });
                const data = await res.json();
                if (!res.ok) {
                    boardResult.textContent = '❌ ' + (data.error || 'Failed to create board.');
                    boardResult.style.color = 'var(--color-error)';
                    return;
                }
                boardResult.innerHTML = '✅ Board created: <strong>' + escapeHtml(data.board.name) + '</strong>';
                boardResult.style.color = 'var(--color-success)';
                createBoardForm.reset();
                loadBoards();
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
            const boardId = boardSelect ? boardSelect.value : '';
            const imageUrl = document.getElementById('pin-image-url').value.trim();
            const title = document.getElementById('pin-title').value.trim();
            const description = document.getElementById('pin-description').value.trim();
            const destinationUrl = document.getElementById('pin-destination-url').value.trim();

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
                const res = await fetch(`${BACKEND}/api/pinterest/pins`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    credentials: 'include',
                    body: JSON.stringify({
                        board_id: boardId,
                        title: title,
                        description: description,
                        image_url: imageUrl,
                        destination_url: destinationUrl
                    })
                });
                const data = await res.json();
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

    // ─── Disconnect button (both pages) ───
    if (homeDisconnectBtn) {
        homeDisconnectBtn.addEventListener('click', disconnectPinterest);
    }

    const disconnectBtnOnPage = document.getElementById('disconnect-pinterest-btn');
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
        const div = document.createElement('div');
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    // ─── Init ───
    updateConnectLinks();
    handleUrlParams();
    checkStatus();
})();
