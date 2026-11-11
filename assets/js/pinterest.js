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
    var PENDING_BOARD_OPERATION_KEY = 'mlh_pending_pinterest_board_operation';
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

    function getPendingBoardOperation(name, description) {
        var fingerprint = JSON.stringify({ name: name, description: description });
        var pending = null;
        try { pending = JSON.parse(localStorage.getItem(PENDING_BOARD_OPERATION_KEY) || 'null'); } catch {}
        if (pending) {
            if (pending.fingerprint !== fingerprint || typeof pending.key !== 'string') {
                throw new Error('A previous board request is unresolved. Reconcile that request before starting a different board creation.');
            }
            return pending;
        }
        var bytes = new Uint8Array(16);
        if (!window.crypto || !window.crypto.getRandomValues) {
            throw new Error('This browser cannot securely create an idempotency key. Update the browser before creating a board.');
        }
        window.crypto.getRandomValues(bytes);
        var key = Array.from(bytes, function (value) { return value.toString(16).padStart(2, '0'); }).join('');
        pending = { key: key, fingerprint: fingerprint };
        localStorage.setItem(PENDING_BOARD_OPERATION_KEY, JSON.stringify(pending));
        return pending;
    }

    function clearPendingBoardOperation(key) {
        try {
            var pending = JSON.parse(localStorage.getItem(PENDING_BOARD_OPERATION_KEY) || 'null');
            if (pending && pending.key === key) localStorage.removeItem(PENDING_BOARD_OPERATION_KEY);
        } catch {}
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
    function updateConnectLinks(prompt) {
        var authUrl = isBackendConfigured() ? BACKEND + '/auth/pinterest' : '#';
        if (prompt) authUrl += '?prompt=' + encodeURIComponent(prompt);
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
            if (data.connected === true && data.session_token) {
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
            if (data.connected === true) {
                showConnectedUI();
            } else if (data.agent_unavailable) {
                if (disconnectError) {
                    disconnectError.textContent = '⚠️ ' + (data.message || 'Pinterest Agent is temporarily unavailable. Your authorization has not been confirmed as invalid; do not reconnect yet.');
                    disconnectError.style.display = 'block';
                }
                return;
            } else if (data.needs_reauth) {
                // Token lacks required scopes — force fresh OAuth with prompt=consent
                sessionToken = null;
                localStorage.removeItem(SESSION_TOKEN_KEY);
                showDisconnectedUI();
                updateConnectLinks('consent');
                if (disconnectError) {
                    disconnectError.textContent = data.refresh_outcome_uncertain
                        ? '⚠️ Pinterest token refresh may have completed, but its final state is uncertain. Do not retry refresh; reconnect Pinterest or verify the account before continuing.'
                        : '⚠️ Pinterest authorization needs attention. Please reconnect Pinterest to restore access.';
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
            var label = document.getElementById('pinterest-connect-label'); if (label) label.textContent = 'Connect Pinterest';
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

            var pendingBoardOperation;
            try {
                pendingBoardOperation = getPendingBoardOperation(name, description);
            } catch (error) {
                showError(boardResult, error.message || 'A previous board operation must be reconciled first.');
                return;
            }

            boardResult.textContent = 'Creating board…';
            boardResult.style.color = 'var(--color-text-light)';

            try {
                var res = await fetch(BACKEND + '/api/pinterest/boards', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': pendingBoardOperation.key }),
                    credentials: 'include',
                    body: JSON.stringify({ name: name, description: description })
                });
                var data = await res.json();
                if (!res.ok) {
                    if (data.operation_rejected === true) {
                        clearPendingBoardOperation(pendingBoardOperation.key);
                    }
                    boardResult.textContent = '❌ ' + (data.outcome_unknown
                        ? 'Board creation outcome is uncertain. Do not create another board; reconcile the existing operation first. ' + (data.error || '')
                        : (data.operation_rejected
                            ? 'The previous board operation was definitively rejected. Resolve the rejection before submitting a new operation. ' + (data.error || '')
                            : (data.error || 'Failed to create board.')));
                    boardResult.style.color = 'var(--color-error)';
                    return;
                }
                clearPendingBoardOperation(pendingBoardOperation.key);
                boardResult.textContent = (data.replayed ? '✓ Existing board creation result recovered: ' : '✓ Board created: ') + (data.board.name || name);
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
                boardResult.textContent = '⚠️ Network outcome is uncertain. The same idempotency key has been retained; do not start a different board creation until this operation is reconciled.';
                boardResult.style.color = 'var(--color-error)';
            }
        });
    }

    // Keep the same key when the user retries an uncertain submission.
    var pendingPinIdempotencyKey = null;

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
            var altText = document.getElementById('pin-alt-text').value.trim();
            var destinationUrl = document.getElementById('pin-destination-url').value.trim();

            if (!boardId) {
                pinResult.textContent = '❌ Please select a board.';
                pinResult.style.color = 'var(--color-error)';
                return;
            }
            if (!imageUrl || !title || !altText || !destinationUrl) {
                pinResult.textContent = '❌ Image URL, title, alt text, and destination URL are required.';
                pinResult.style.color = 'var(--color-error)';
                return;
            }

            if (!pendingPinIdempotencyKey) {
                pendingPinIdempotencyKey = (window.crypto && window.crypto.randomUUID)
                    ? window.crypto.randomUUID()
                    : 'mlh-' + Date.now() + '-' + Math.random().toString(16).slice(2);
            }
            pinResult.textContent = 'Publishing pin…';
            pinResult.style.color = 'var(--color-text-light)';

            try {
                var res = await fetch(BACKEND + '/api/pinterest/pins', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': pendingPinIdempotencyKey }),
                    credentials: 'include',
                    body: JSON.stringify({
                        board_id: boardId,
                        title: title,
                        description: description,
                        alt_text: altText,
                        image_url: imageUrl,
                        destination_url: destinationUrl
                    })
                });
                var data = await res.json();
                if (!res.ok) {
                    pinResult.textContent = data.outcome_unknown
                        ? '⚠️ Publish outcome is uncertain. Do not create a new request key; check the Pinterest board and publication record first. ' + (data.error || '')
                        : '❌ ' + (data.error || 'Failed to create pin.');
                    pinResult.style.color = 'var(--color-error)';
                    return;
                }
                pinResult.innerHTML = '✅ Pin published successfully! Pin ID: <strong>' + escapeHtml(data.pin.id) + '</strong>';
                pinResult.style.color = 'var(--color-success)';
                pendingPinIdempotencyKey = null;
                createPinForm.reset();
                loadBoards();
            } catch {
                pinResult.textContent = '⚠️ Network outcome is uncertain. Do not submit a new request; verify the Pinterest board before retrying with the same key.';
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
                if (data.provider_token_revoked === false) {
                    showError(disconnectError, 'Pinterest was disconnected locally. Pinterest-side token revocation was NOT performed; revoke Modern Living Hub access separately in your Pinterest account settings if required.');
                }
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

    // ─── Pinterest Trend Intelligence (official read-only Trends API) ───
    var trendButton = document.getElementById('load-pinterest-trends-btn');
    var trendStatus = document.getElementById('trend-intelligence-status');
    var trendResults = document.getElementById('trend-intelligence-results');
    function renderPinterestTrends(payload) {
        if (!trendResults) return;
        trendResults.replaceChildren();
        (payload.regions || []).forEach(function (region) {
            var section = document.createElement('section');
            var heading = document.createElement('h4');
            heading.textContent = region.region_name + ' — growing search terms';
            section.appendChild(heading);
            var list = document.createElement('ol');
            (region.trends || []).forEach(function (trend) {
                var item = document.createElement('li');
                item.style.cssText = 'padding:0.65rem 0;border-bottom:1px solid var(--color-border);';
                var name = document.createElement('strong');
                name.textContent = trend.keyword;
                var growth = document.createElement('p');
                growth.style.margin = '0.2rem 0 0';
                function pct(value) { return value === null || value === undefined ? 'Not reported' : (Number(value) > 10000 ? '>10,000%' : Number(value).toLocaleString() + '%'); }
                growth.textContent = 'WoW: ' + pct(trend.growth_week_over_week_pct) + ' · MoM: ' + pct(trend.growth_month_over_month_pct) + ' · YoY: ' + pct(trend.growth_year_over_year_pct);
                item.append(name, growth);
                list.appendChild(item);
            });
            section.appendChild(list);
            trendResults.appendChild(section);
        });
        var stamp = document.createElement('p');
        stamp.textContent = 'Source: ' + payload.source + ' · Fetched: ' + payload.fetched_at + ' · Trend type: ' + payload.trend_type;
        trendResults.appendChild(stamp);
    }
    async function loadPinterestTrends() {
        if (!isBackendConfigured()) return;
        var regions = [];
        if (document.getElementById('trend-region-us')?.checked) regions.push('US');
        if (document.getElementById('trend-region-gb')?.checked) regions.push('GB+IE');
        if (!regions.length) { if (trendStatus) trendStatus.textContent = 'Select at least one market.'; return; }
        if (trendButton) trendButton.disabled = true;
        if (trendStatus) trendStatus.textContent = 'Requesting current Pinterest Trends data…';
        try {
            var response = await fetch(BACKEND + '/api/pinterest/trend-intelligence/run', {
                method: 'POST', credentials: 'include',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ regions: regions })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.ok === false) {
                if (data.requires_scope) throw new Error('Reconnect Pinterest and approve ' + data.requires_scope + '.');
                throw new Error(data.note || data.error || 'Pinterest trends unavailable.');
            }
            renderPinterestTrends(data);
            if (trendStatus) trendStatus.textContent = 'Loaded real Pinterest trend records for ' + (data.regions || []).length + ' market(s).';
        } catch (error) {
            if (trendStatus) trendStatus.textContent = error.message || 'Could not load Pinterest trends.';
        } finally {
            if (trendButton) trendButton.disabled = false;
        }
    }
    if (trendButton) trendButton.addEventListener('click', loadPinterestTrends);

    // ─── Pinterest Featured Topics + sample Pin visuals (read-only) ───
    var featuredButton = document.getElementById('load-featured-topics-btn');
    var featuredStatus = document.getElementById('featured-topics-status');
    var featuredResults = document.getElementById('featured-topics-results');
    function renderFeaturedTopics(payload) {
        if (!featuredResults) return;
        featuredResults.replaceChildren();
        (payload.regions || []).forEach(function (market) {
            var section = document.createElement('section');
            var heading = document.createElement('h4');
            heading.textContent = market.region_name + ' — featured topics';
            section.appendChild(heading);
            (market.topics || []).forEach(function (topic) {
                var card = document.createElement('article');
                card.style.cssText = 'padding:0.85rem 0;border-bottom:1px solid var(--color-border);';
                var title = document.createElement('h5');
                title.textContent = topic.title || 'Untitled topic';
                card.appendChild(title);
                if (topic.description) { var desc = document.createElement('p'); desc.textContent = topic.description; card.appendChild(desc); }
                if (topic.growth_month_over_month_pct !== null && topic.growth_month_over_month_pct !== undefined) {
                    var growth = document.createElement('p');
                    growth.textContent = 'Month-over-month growth: ' + Number(topic.growth_month_over_month_pct).toLocaleString() + '%';
                    card.appendChild(growth);
                }
                [['Related searches', topic.related_searches], ['Related interests', topic.related_interests]].forEach(function (pair) {
                    if (!Array.isArray(pair[1]) || !pair[1].length) return;
                    var p = document.createElement('p');
                    p.textContent = pair[0] + ': ' + pair[1].join(', ');
                    card.appendChild(p);
                });
                var samples = Array.isArray(topic.example_pins) ? topic.example_pins : [];
                if (samples.length) {
                    var gallery = document.createElement('div');
                    gallery.style.cssText = 'display:flex;gap:0.75rem;flex-wrap:wrap;';
                    samples.forEach(function (sample) {
                        try {
                            var url = new URL(sample.image_url);
                            if (url.protocol !== 'https:' || (url.hostname !== 'i.pinimg.com' && !url.hostname.endsWith('.i.pinimg.com'))) return;
                            var figure = document.createElement('figure');
                            figure.style.cssText = 'margin:0;width:130px;';
                            var img = document.createElement('img');
                            img.src = url.href; img.alt = 'Pinterest example Pin for ' + (topic.title || 'featured topic');
                            img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
                            img.style.cssText = 'width:100%;height:auto;max-height:190px;object-fit:cover;border-radius:8px;';
                            figure.appendChild(img);
                            var caption = document.createElement('figcaption');
                            caption.style.cssText = 'font-size:0.78rem;color:var(--color-text-light);';
                            caption.textContent = (sample.width || '?') + ' × ' + (sample.height || '?') +
                                (sample.dominant_color ? ' · ' + sample.dominant_color : '');
                            figure.appendChild(caption); gallery.appendChild(figure);
                        } catch (_) { /* Ignore malformed image URLs. */ }
                    });
                    card.appendChild(gallery);
                }
                section.appendChild(card);
            });
            featuredResults.appendChild(section);
        });
        var stamp = document.createElement('p');
        stamp.textContent = 'Source: ' + payload.source + ' · Fetched: ' + payload.fetched_at + ' · Read-only';
        featuredResults.appendChild(stamp);
    }
    async function loadFeaturedTopics() {
        if (!isBackendConfigured()) return;
        var regions = [];
        if (document.getElementById('trend-region-us')?.checked) regions.push('US');
        if (document.getElementById('trend-region-gb')?.checked) regions.push('GB+IE');
        if (!regions.length) { if (featuredStatus) featuredStatus.textContent = 'Select at least one market above.'; return; }
        if (featuredButton) featuredButton.disabled = true;
        if (featuredStatus) featuredStatus.textContent = 'Fetching Pinterest featured topics and sample images…';
        try {
            var response = await fetch(BACKEND + '/api/pinterest/trend-visuals/run', {
                method: 'POST', credentials: 'include',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ regions: regions })
            });
            var data = await response.json().catch(function () { return {}; });
            if (!response.ok || data.ok === false) {
                if (data.requires_scope) throw new Error('Reconnect Pinterest and approve ' + data.requires_scope + '.');
                throw new Error(data.note || data.error || 'Featured topics unavailable.');
            }
            renderFeaturedTopics(data);
            if (featuredStatus) featuredStatus.textContent = 'Loaded real featured topics for ' + (data.regions || []).length + ' market(s).';
        } catch (error) {
            if (featuredStatus) featuredStatus.textContent = error.message || 'Could not load featured topics.';
        } finally {
            if (featuredButton) featuredButton.disabled = false;
        }
    }
    if (featuredButton) featuredButton.addEventListener('click', loadFeaturedTopics);


    var analyticsStatus = document.getElementById('analytics-status');
    var engagementResults = document.getElementById('engagement-analytics-results');
    var loadEngagementBtn = document.getElementById('load-engagement-analytics-btn');

    function setAnalyticsStatus(message, isError) {
        if (!analyticsStatus) return;
        analyticsStatus.textContent = message;
        analyticsStatus.style.color = isError ? 'var(--color-error)' : 'var(--color-text-light)';
    }

    function renderMetricList(target, heading, metrics) {
        if (!target) return;
        var title = document.createElement('h4');
        title.textContent = heading;
        var list = document.createElement('dl');
        list.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0.75rem;';
        Object.keys(metrics || {}).forEach(function (key) {
            var wrap = document.createElement('div');
            wrap.style.cssText = 'padding:0.75rem;border:1px solid var(--color-border);border-radius:8px;';
            var label = document.createElement('dt');
            label.textContent = key.replace(/_/g, ' ');
            label.style.cssText = 'text-transform:capitalize;font-size:0.85rem;color:var(--color-text-light);';
            var value = document.createElement('dd');
            var raw = metrics[key];
            value.textContent = raw === null || raw === undefined ? 'Not available' :
                (key.indexOf('rate') >= 0 ? (Number(raw) * 100).toFixed(2) + '%' : Number(raw).toLocaleString());
            value.style.cssText = 'font-weight:700;font-size:1.25rem;margin:0.25rem 0 0;';
            wrap.appendChild(label);
            wrap.appendChild(value);
            list.appendChild(wrap);
        });
        target.replaceChildren(title, list);
    }


    async function loadEngagementAnalytics() {
        if (!isBackendConfigured()) return;
        if (loadEngagementBtn) loadEngagementBtn.disabled = true;
        setAnalyticsStatus('Loading organic Pin engagement from Pinterest…', false);
        try {
            var res = await fetch(BACKEND + '/api/pinterest/analytics/run', {
                method: 'POST', credentials: 'include',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ period_days: 30 })
            });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok) throw new Error(data.error || data.detail || 'Engagement analytics could not be loaded.');
            renderMetricList(engagementResults, 'Organic engagement — last 30 days', data.aggregate_metrics || {});
            var pinsChecked = Number.isFinite(Number(data.pins_checked)) ? Number(data.pins_checked) : 0;
            var snapshotsSaved = Number.isFinite(Number(data.snapshots_saved)) ? Number(data.snapshots_saved) : 0;
            if (data.ok === false) {
                var pinResults = Array.isArray(data.pin_results) ? data.pin_results : [];
                var failedPins = pinResults.length === pinsChecked
                    ? pinResults.filter(function (pin) { return pin && pin.ok === false; }).length
                    : Math.max(0, pinsChecked - snapshotsSaved);
                setAnalyticsStatus(
                    'Partial analytics result: ' + snapshotsSaved + ' of ' + pinsChecked +
                    ' published Pins saved; ' + failedPins + ' failed. Available metrics are shown above. Retry later for failed Pins. Predictive ML is not trained.',
                    true
                );
            } else {
                setAnalyticsStatus(snapshotsSaved + ' Pin analytics snapshots saved for ' + pinsChecked + ' published Pins. Predictive ML is not trained.', false);
            }
        } catch (err) {
            setAnalyticsStatus(err.message || 'Engagement analytics could not be loaded.', true);
        } finally {
            if (loadEngagementBtn) loadEngagementBtn.disabled = false;
        }
    }


    if (loadEngagementBtn) loadEngagementBtn.addEventListener('click', loadEngagementAnalytics);

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
