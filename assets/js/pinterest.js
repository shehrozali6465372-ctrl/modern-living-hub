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
            } else if (data.needs_reauth) {
                // Token lacks required scopes — force fresh OAuth with prompt=consent
                sessionToken = null;
                localStorage.removeItem(SESSION_TOKEN_KEY);
                showDisconnectedUI();
                updateConnectLinks('consent');
                if (disconnectError) {
                    disconnectError.textContent = '⚠️ Your Pinterest token is missing required permissions. Please reconnect Pinterest to grant all permissions.';
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
        loadAdvertiserAccounts();
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
        // Reuse one key for identical retries from this form; never mint a new
        // key while the same payload may already be in flight or uncertain.
        var pendingManualPinRequest = null;
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

            var pinPayload = {
                board_id: boardId,
                title: title,
                description: description,
                image_url: imageUrl,
                destination_url: destinationUrl
            };
            var pinFingerprint = JSON.stringify(pinPayload);
            if (!pendingManualPinRequest || pendingManualPinRequest.fingerprint !== pinFingerprint) {
                var newKey = (window.crypto && typeof window.crypto.randomUUID === 'function')
                    ? window.crypto.randomUUID()
                    : Array.from(window.crypto.getRandomValues(new Uint8Array(16))).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
                pendingManualPinRequest = { fingerprint: pinFingerprint, key: newKey };
            }

            pinResult.textContent = 'Submitting through secure publication gateway…';
            pinResult.style.color = 'var(--color-text-light)';

            try {
                var res = await fetch(BACKEND + '/api/pinterest/pins', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json', 'Idempotency-Key': pendingManualPinRequest.key }),
                    credentials: 'include',
                    body: JSON.stringify(pinPayload)
                });
                var data = await res.json();
                if (!res.ok) {
                    pinResult.textContent = '❌ ' + (data.error || 'Failed to create pin.');
                    pinResult.style.color = 'var(--color-error)';
                    return;
                }
                pinResult.innerHTML = '✅ Pin published successfully! Pin ID: <strong>' + escapeHtml(data.pin.id) + '</strong>';
                pinResult.style.color = 'var(--color-success)';
                pendingManualPinRequest = null;
                createPinForm.reset();
                loadBoards();
            } catch {
                pinResult.textContent = '❌ Could not reach the server. Please try again.';
                pinResult.style.color = 'var(--color-error)';
            }
        });
    }

    // ─── Read-only listing of existing Pinterest Pins ───
    var loadPinsBtn = document.getElementById('load-pins-btn');
    var loadMorePinsBtn = document.getElementById('load-more-pins-btn');
    var pinsListStatus = document.getElementById('pins-list-status');
    var existingPinsList = document.getElementById('existing-pins-list');
    var pinsBookmark = null;
    var pinsLoaded = false;
    var eligibleProductPinCount = 0;
    var productPinDiscoveryStatus = document.getElementById('product-pin-discovery-status');

    function appendPinCard(pin) {
        var card = document.createElement('article');
        card.className = 'pinterest-card';
        card.style.marginTop = '0.75rem';
        var heading = document.createElement('h4');
        heading.textContent = pin.title || 'Untitled Pin';
        var id = document.createElement('p');
        id.textContent = 'Pin ID: ' + String(pin.id || 'Unavailable');
        var description = document.createElement('p');
        description.textContent = pin.description || '';
        var board = document.createElement('p');
        board.textContent = 'Board ID: ' + String(pin.board_id || 'Unavailable');
        var productStatus = document.createElement('p');
        productStatus.textContent = pin.is_product === true ? 'Pinterest type: Eligible Product Pin' : 'Pinterest type: Standard / non-product Pin';
        card.appendChild(heading);
        card.appendChild(id);
        card.appendChild(productStatus);
        if (description.textContent) card.appendChild(description);
        card.appendChild(board);
        if (pin.is_product === true) {
            eligibleProductPinCount += 1;
            var selectProduct = document.createElement('button');
            selectProduct.type = 'button';
            selectProduct.className = 'btn btn-secondary';
            selectProduct.textContent = 'Use as Product Tag';
            selectProduct.addEventListener('click', function () {
                var field = document.getElementById('product-pin-ids');
                if (!field) return;
                var ids = field.value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
                if (!ids.includes(String(pin.id))) ids.push(String(pin.id));
                field.value = ids.join(', ');
            });
            card.appendChild(selectProduct);
        } else {
            var selectHero = document.createElement('button');
            selectHero.type = 'button';
            selectHero.className = 'btn btn-secondary';
            selectHero.textContent = 'Use as Hero Pin';
            selectHero.addEventListener('click', function () {
                var field = document.getElementById('hero-pin-id');
                if (field) field.value = String(pin.id || '');
            });
            card.appendChild(selectHero);
        }
        if (pin.link) {
            var link = document.createElement('a');
            link.href = pin.link;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = 'Open Pin on Pinterest';
            card.appendChild(link);
        }
        existingPinsList.appendChild(card);
    }

    async function loadExistingPins(append) {
        if (!isBackendConfigured() || !existingPinsList || !pinsListStatus) return;
        if (!append) {
            pinsBookmark = null;
            eligibleProductPinCount = 0;
            existingPinsList.replaceChildren();
            pinsLoaded = false;
        }
        pinsListStatus.textContent = 'Loading existing Pins…';
        if (loadPinsBtn) loadPinsBtn.disabled = true;
        if (loadMorePinsBtn) loadMorePinsBtn.disabled = true;
        try {
            var query = '?page_size=50';
            if (append && pinsBookmark) query += '&bookmark=' + encodeURIComponent(pinsBookmark);
            var res = await fetch(BACKEND + '/api/pinterest/pins/list' + query, {
                method: 'GET', credentials: 'include', headers: authHeaders()
            });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok) {
                pinsListStatus.textContent = res.status === 401
                    ? 'Session authentication failed. Refresh this page or reconnect Pinterest.'
                    : (data.error || 'Could not load Pinterest Pins.');
                if (loadMorePinsBtn) loadMorePinsBtn.style.display = 'none';
                return;
            }
            var pins = Array.isArray(data.pins) ? data.pins : [];
            pins.forEach(appendPinCard);
            pinsBookmark = data.bookmark || null;
            pinsLoaded = true;
            pinsListStatus.textContent = pins.length
                ? 'Loaded ' + pins.length + ' Pin(s).' + (pinsBookmark ? ' More Pins are available.' : ' End of list.')
                : (append ? 'No additional Pins found.' : 'No Pins found for this account.');
            if (productPinDiscoveryStatus) {
                productPinDiscoveryStatus.textContent = eligibleProductPinCount
                    ? 'Found ' + eligibleProductPinCount + ' eligible Product Pin(s) on the pages loaded. Use “Use as Product Tag” to select them.'
                    : (pinsBookmark
                        ? 'No eligible Product Pins on the pages loaded yet. Load more Pins or create a Product Pin in Pinterest using the product-page link, then reload.'
                        : 'No eligible Product Pins found in this account listing. Create a Product Pin in Pinterest using the product-page link, then reload this list.');
            }
            if (loadMorePinsBtn) loadMorePinsBtn.style.display = pinsBookmark ? 'inline-block' : 'none';
        } catch (err) {
            pinsListStatus.textContent = 'Could not reach the Hub API. Please retry.';
        } finally {
            if (loadPinsBtn) loadPinsBtn.disabled = false;
            if (loadMorePinsBtn) loadMorePinsBtn.disabled = false;
        }
    }

    if (loadPinsBtn) loadPinsBtn.addEventListener('click', function () { loadExistingPins(false); });
    if (loadMorePinsBtn) loadMorePinsBtn.addEventListener('click', function () { if (pinsLoaded && pinsBookmark) loadExistingPins(true); });

    // ─── Attach native Pinterest product tags to an existing hero Pin ───
    var productTagsForm = document.getElementById("product-tags-form");
    var productTagsResult = document.getElementById("product-tags-result");
    if (productTagsForm) {
        productTagsForm.addEventListener("submit", async function (e) {
            e.preventDefault();
            var heroPinId = document.getElementById("hero-pin-id").value.trim();
            var productPinIds = document.getElementById("product-pin-ids").value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
            if (!heroPinId || productPinIds.length < 1 || productPinIds.length > 24 || new Set(productPinIds).size !== productPinIds.length) {
                productTagsResult.textContent = "❌ Enter one hero Pin ID and 1–24 unique product Pin IDs.";
                productTagsResult.style.color = "var(--color-error)";
                return;
            }
            productTagsResult.textContent = "Checking existing tags and attaching missing product tags…";
            productTagsResult.style.color = "var(--color-text-light)";
            try {
                var res = await fetch(BACKEND + "/api/pinterest/pins/" + encodeURIComponent(heroPinId) + "/product-tags", {
                    method: "POST", credentials: "include",
                    headers: authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify({ product_pin_ids: productPinIds })
                });
                var data = await res.json();
                if (!res.ok) {
                    productTagsResult.textContent = "❌ " + (data.error || "Product tags could not be verified. Inspect current tags before retrying.");
                    productTagsResult.style.color = "var(--color-error)";
                    return;
                }
                productTagsResult.textContent = "✅ Verified " + data.verified_product_pin_ids.length + " product tag(s) on hero Pin " + data.pin_id + ". Newly attached: " + data.newly_attached.length + "; already present: " + data.already_attached.length + ".";
                productTagsResult.style.color = "var(--color-success)";
            } catch (err) {
                productTagsResult.textContent = "❌ Request outcome may be uncertain. Read current product tags before retrying.";
                productTagsResult.style.color = "var(--color-error)";
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

    // ─── Audience & Engagement Analytics (read-only reporting) ───
    var analyticsStatus = document.getElementById('analytics-status');
    var engagementResults = document.getElementById('engagement-analytics-results');
    var audienceResults = document.getElementById('audience-insights-results');
    var loadEngagementBtn = document.getElementById('load-engagement-analytics-btn');
    var loadAudienceBtn = document.getElementById('load-audience-insights-btn');
    var advertiserSelect = document.getElementById('audience-ad-account-select');
    var reconnectAdsLink = document.getElementById('reconnect-ads-link');

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

    async function loadAdvertiserAccounts() {
        if (!advertiserSelect || !isBackendConfigured()) return;
        try {
            var res = await fetch(BACKEND + '/api/pinterest/ad-accounts', {
                credentials: 'include', headers: authHeaders()
            });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok || data.ok === false || data.requires_scope) {
                advertiserSelect.innerHTML = '<option value="">Advertiser access unavailable</option>';
                if (loadAudienceBtn) loadAudienceBtn.disabled = true;
                if (data.requires_scope && reconnectAdsLink) {
                    reconnectAdsLink.href = BACKEND + '/auth/pinterest?prompt=consent';
                    reconnectAdsLink.style.display = 'inline';
                }
                setAnalyticsStatus(data.note || data.error || 'Pinterest advertiser access is unavailable for this account.', true);
                return;
            }
            if (reconnectAdsLink) reconnectAdsLink.style.display = 'none';
            var accounts = Array.isArray(data.ad_accounts) ? data.ad_accounts : [];
            advertiserSelect.innerHTML = '<option value="">Select advertiser account</option>';
            accounts.forEach(function (account) {
                var option = document.createElement('option');
                option.value = account.id;
                option.textContent = (account.name || 'Pinterest advertiser') + ' (' + account.id + ')';
                advertiserSelect.appendChild(option);
            });
            if (loadAudienceBtn) loadAudienceBtn.disabled = accounts.length === 0;
            if (!accounts.length) setAnalyticsStatus('No advertiser accounts are available for this Pinterest login. Verify Business Access.', true);
        } catch {
            advertiserSelect.innerHTML = '<option value="">Could not load advertiser accounts</option>';
            if (loadAudienceBtn) loadAudienceBtn.disabled = true;
            setAnalyticsStatus('Could not reach Pinterest advertiser account reporting.', true);
        }
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

    function renderAudienceBreakdown(target, audience) {
        if (!target) return;
        var root = document.createElement('section');
        root.style.cssText = 'display:grid;gap:1rem;margin-top:1rem;';
        var title = document.createElement('h4');
        title.textContent = audience.audience_insight_type === 'YOUR_TOTAL_AUDIENCE' ? 'Your Total Audience' : 'Your Engaged Audience';
        root.appendChild(title);
        var breakdown = audience.breakdown || {};
        if (breakdown.audience_size !== null && breakdown.audience_size !== undefined) {
            var size = document.createElement('p');
            size.textContent = 'Estimated audience size: ' + Number(breakdown.audience_size).toLocaleString() +
                (breakdown.size_is_upper_bound ? ' (rounded upper bound)' : '');
            root.appendChild(size);
        }
        [
            ['countries', 'Countries'],
            ['cities_or_metros', 'Top cities / metro areas'],
            ['age_groups', 'Age groups'],
            ['gender', 'Gender'],
            ['devices', 'Devices / Pinterest access'],
            ['interests', 'Interests']
        ].forEach(function (entry) {
            var items = breakdown[entry[0]];
            if (!Array.isArray(items) || !items.length) return;
            var section = document.createElement('div');
            var heading = document.createElement('h5');
            heading.textContent = entry[1];
            section.appendChild(heading);
            items.forEach(function (item) {
                var line = document.createElement('div');
                line.style.cssText = 'display:grid;grid-template-columns:minmax(110px,1fr) minmax(80px,2fr) 54px;gap:0.5rem;align-items:center;margin:0.4rem 0;';
                var label = document.createElement('span');
                label.textContent = item.name;
                var track = document.createElement('span');
                track.style.cssText = 'height:9px;border-radius:8px;background:var(--color-border);overflow:hidden;';
                var fill = document.createElement('span');
                fill.style.cssText = 'display:block;height:100%;border-radius:8px;background:var(--color-primary,#6b7280);width:' +
                    (item.percentage === null ? 0 : Math.min(100, Math.max(0, item.percentage))) + '%;';
                track.appendChild(fill);
                var value = document.createElement('strong');
                value.style.textAlign = 'right';
                value.textContent = item.percentage === null ? '—' : item.percentage.toFixed(1) + '%';
                line.append(label, track, value);
                section.appendChild(line);
            });
            root.appendChild(section);
        });
        [
            breakdown.location_note,
            breakdown.age_note,
            breakdown.gender_note,
            breakdown.device_note
        ].filter(Boolean).forEach(function (message) {
            var note = document.createElement('p');
            note.style.cssText = 'font-size:0.85rem;color:var(--color-text-light);';
            note.textContent = message;
            root.appendChild(note);
        });
        target.appendChild(root);
    }

    async function loadAudienceInsights() {
        var adAccountId = advertiserSelect && advertiserSelect.value;
        if (!adAccountId) {
            setAnalyticsStatus('Select a Pinterest advertiser account first.', true);
            return;
        }
        if (loadAudienceBtn) loadAudienceBtn.disabled = true;
        setAnalyticsStatus('Loading aggregated 30-day audience insights…', false);
        try {
            var res = await fetch(BACKEND + '/api/pinterest/audience-insights', {
                method: 'POST', credentials: 'include',
                headers: authHeaders({ 'Content-Type': 'application/json' }),
                body: JSON.stringify({ ad_account_id: adAccountId })
            });
            var data = await res.json().catch(function () { return {}; });
            if (!res.ok || data.ok === false) throw new Error(data.note || data.error || 'Audience insights could not be loaded.');
            if (audienceResults) {
                audienceResults.replaceChildren();
                (data.audience_insights || []).forEach(function (audience) {
                    renderAudienceBreakdown(audienceResults, audience);
                });
            }
            setAnalyticsStatus((data.snapshots_saved || 0) + ' aggregated audience insight snapshots saved. Pinterest audience insights use a fixed rolling 30-day window.', false);
        } catch (err) {
            setAnalyticsStatus(err.message || 'Audience insights could not be loaded.', true);
        } finally {
            if (loadAudienceBtn) loadAudienceBtn.disabled = !advertiserSelect || !advertiserSelect.value;
        }
    }

    if (loadEngagementBtn) loadEngagementBtn.addEventListener('click', loadEngagementAnalytics);
    if (loadAudienceBtn) loadAudienceBtn.addEventListener('click', loadAudienceInsights);
    if (advertiserSelect) advertiserSelect.addEventListener('change', function () {
        if (loadAudienceBtn) loadAudienceBtn.disabled = !advertiserSelect.value;
    });

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
