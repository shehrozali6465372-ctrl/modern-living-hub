/**
 * Modern Living Hub — YouTube Integration Frontend
 * Handles OAuth handoff, session token, channel info, video upload,
 * and processing status via the server-side YouTube backend API.
 */

(function () {
    'use strict';

    var BACKEND = (window.BACKEND_URL || '').replace(/\/+$/, '');
    var SESSION_TOKEN_KEY = 'mlh_youtube_session_token';
    var sessionToken = localStorage.getItem(SESSION_TOKEN_KEY) || null;

    var CONNECTING_TEXT = 'Connecting…';
    var CONNECT_TEXT = 'Connect YouTube';
    var RECONNECT_TEXT = 'Reconnect YouTube';

    function isBackendConfigured() {
        return Boolean(BACKEND) && !BACKEND.includes('YOUR-BACKEND');
    }

    function authHeaders(extra) {
        var headers = Object.assign({}, extra || {});
        if (sessionToken) {
            headers['Authorization'] = 'Bearer ' + sessionToken;
        }
        return headers;
    }

    function setLoading(show) {
        var loading = document.getElementById('loading-state');
        if (loading) loading.style.display = show ? 'block' : 'none';
    }

    function setDisconnectedError(msg) {
        var err = document.getElementById('disconnect-error');
        if (err) {
            err.textContent = msg;
            err.style.display = 'block';
        }
    }

    function showErrorBanner(msg) {
        var banner = document.getElementById('yt-error-banner');
        var text = document.getElementById('yt-error-text');
        if (banner && text) {
            text.textContent = msg;
            banner.style.display = 'flex';
        }
    }

    function clearErrorBanner() {
        var banner = document.getElementById('yt-error-banner');
        if (banner) banner.style.display = 'none';
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    // ─── DOM references ───
    var connectBtn = document.getElementById('connect-youtube-btn');
    var loadingState = document.getElementById('loading-state');
    var connectedState = document.getElementById('connected-state');
    var disconnectedState = document.getElementById('disconnected-state');
    var channelInfo = document.getElementById('channel-info');
    var uploadForm = document.getElementById('upload-form');
    var uploadResult = document.getElementById('upload-result');
    var disconnectModal = document.getElementById('disconnect-modal');
    var disconnectCancelBtn = document.getElementById('disconnect-cancel-btn');
    var disconnectConfirmBtn = document.getElementById('disconnect-confirm-btn');
    var disconnectBtn = document.getElementById('disconnect-youtube-btn');
    var uploadBtn = document.getElementById('upload-btn');
    var uploadBtnText = document.getElementById('upload-btn-text');
    var uploadBtnSpinner = document.getElementById('upload-btn-spinner');
    var videoFile = document.getElementById('video-file');
    var videoInfo = document.getElementById('video-info');

    // ─── UI state helpers ───
    function showConnectedUI() {
        setLoading(false);
        clearErrorBanner();
        if (connectedState) connectedState.style.display = 'block';
        if (disconnectedState) disconnectedState.style.display = 'none';
        if (connectBtn) {
            connectBtn.textContent = '\u2705 Connected';
            connectBtn.classList.add('yt-btn-connected');
            connectBtn.href = '#';
            connectBtn.style.pointerEvents = 'none';
        }
        loadChannelInfo();
    }

    function showDisconnectedUI() {
        setLoading(false);
        clearErrorBanner();
        if (connectedState) connectedState.style.display = 'none';
        if (disconnectedState) disconnectedState.style.display = 'block';
        if (connectBtn) {
            connectBtn.textContent = CONNECT_TEXT;
            connectBtn.classList.remove('yt-btn-connected');
            connectBtn.href = isBackendConfigured() ? BACKEND + '/youtube/auth' : '#';
            connectBtn.style.pointerEvents = isBackendConfigured() ? 'auto' : 'none';
            connectBtn.style.opacity = isBackendConfigured() ? '' : '0.5';
        }
        if (channelInfo) channelInfo.innerHTML = '';
        if (uploadForm) uploadForm.reset();
        if (uploadResult) { uploadResult.style.display = 'none'; uploadResult.textContent = ''; }
    }

    function showConnecting() {
        setLoading(false);
        clearErrorBanner();
        if (connectBtn) {
            connectBtn.textContent = CONNECTING_TEXT;
            connectBtn.style.pointerEvents = 'none';
        }
        var label = document.querySelector('.yt-status-title');
        if (!label) return;
    }

    // ─── Complete handoff ───
    async function completeYTHandoff(code) {
        if (!isBackendConfigured()) {
            showErrorBanner('Backend URL not configured. Set window.BACKEND_URL first.');
            showDisconnectedUI();
            return false;
        }
        try {
            var res = await fetch(BACKEND + '/api/youtube/complete', {
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
                showErrorBanner(data.error || 'Could not complete YouTube connection.');
                showDisconnectedUI();
                return false;
            }
        } catch (e) {
            showErrorBanner('Could not reach the server to complete YouTube connection.');
            showDisconnectedUI();
            return false;
        }
    }

    // ─── Handle OAuth return params ───
    async function handleUrlParams() {
        var params = new URLSearchParams(window.location.search);
        var handoff = params.get('yt_handoff');
        var error = params.get('yt_error');

        if (params.get('youtube_connected') === '1' && handoff) {
            // Immediately clean the URL so refresh doesn't re-consume the handoff.
            window.history.replaceState({}, '', window.location.pathname);
            var completed = await completeYTHandoff(handoff);
            return completed; // true = handoff was processed; do not race with checkStatus
        }

        if (error) {
            window.history.replaceState({}, '', window.location.pathname);
            showErrorBanner(decodeURIComponent(error));
            showDisconnectedUI();
        }
        return false;
    }

    // ─── Load channel info ───
    async function loadChannelInfo() {
        if (!channelInfo) return;

        if (!sessionToken) {
            channelInfo.innerHTML = '<p>Not connected.</p>';
            return;
        }

        channelInfo.innerHTML = '<p class="yt-channel-loading">Loading channel information…</p>';

        try {
            var res = await fetch(BACKEND + '/api/youtube/channel', {
                headers: authHeaders(),
                credentials: 'include'
            });

            if (res.status === 401) {
                // Genuine session expiry (invalid/expired bearer) — clear ONLY
                // the YouTube session token and show disconnected state.
                sessionToken = null;
                localStorage.removeItem(SESSION_TOKEN_KEY);
                showDisconnectedUI();
                showErrorBanner('Connection expired — reconnect YouTube.');
                return;
            }

            if (res.status === 403) {
                // Permission/scope rejection from Google for channel data. The
                // session itself is valid — DO NOT clear the token or disconnect.
                channelInfo.innerHTML = '<p class="yt-channel-error">Channel information is not available for this account.</p>';
                showErrorBanner('Channel information is currently unavailable. Your connection is still active.');
                return;
            }

            if (!res.ok) {
                // Other transient/server errors — keep the Connected state visible.
                var errData = {};
                try { errData = await res.json(); } catch (_e) {}
                channelInfo.innerHTML = '<p class="yt-channel-error">Could not load channel info.</p>';
                showErrorBanner(errData.error || 'Could not load channel information. Your connection is still active.');
                return;
            }

            var data = await res.json();
            renderChannelInfo(data);
        } catch (e) {
            channelInfo.innerHTML = '<p class="yt-channel-error">Could not reach the server.</p>';
            showErrorBanner('Could not reach the server to load channel information.');
        }
    }

    function renderChannelInfo(data) {
        if (!channelInfo) return;
        // Data may come as {channel: {...}} from backend, or flat {id, title, ...} for backward compat
        var ch = data.channel || data;
        var html = '<div class="yt-channel-avatar">';
        if (ch.thumbnail) {
            html += '<img src="' + escapeHtml(ch.thumbnail) + '" alt="Channel thumbnail" width="64" height="64">';
        } else {
            html += '<span class="yt-channel-placeholder">' + escapeHtml((ch.title || 'C')[0].toUpperCase()) + '</span>';
        }
        html += '</div>';
        html += '<div class="yt-channel-meta">';
        html += '<p class="yt-channel-name"><strong>' + escapeHtml(ch.title || 'My Channel') + '</strong></p>';
        if (ch.id) html += '<p class="yt-channel-id">Channel ID: <code>' + escapeHtml(ch.id) + '</code></p>';
        html += '</div>';
        channelInfo.innerHTML = '<div class="yt-channel-detail">' + html + '</div>';
    }

    // ─── Status check ───
    async function checkStatus() {
        if (!isBackendConfigured()) {
            showErrorBanner('Backend URL not configured. Set window.BACKEND_URL first.');
            showDisconnectedUI();
            return;
        }

        if (!sessionToken) {
            showDisconnectedUI();
            return;
        }

        try {
            var res = await fetch(BACKEND + '/api/youtube/status', {
                headers: authHeaders(),
                credentials: 'include'
            });
            var data = await res.json();

            if (data.connected) {
                showConnectedUI();
            } else {
                // Session expired or invalid
                sessionToken = null;
                localStorage.removeItem(SESSION_TOKEN_KEY);
                showDisconnectedUI();
            }
        } catch (e) {
            showErrorBanner('Could not reach the server. Check your internet connection.');
            showDisconnectedUI();
        } finally {
            setLoading(false);
        }
    }

    // ─── Connect button ───
    if (connectBtn) {
        connectBtn.addEventListener('click', function (e) {
            if (!isBackendConfigured()) {
                e.preventDefault();
                showErrorBanner('Backend URL not configured. Set window.BACKEND_URL first.');
                return;
            }
            if (connectBtn.textContent === CONNECTING_TEXT) {
                e.preventDefault();
                return;
            }
            connectBtn.textContent = CONNECTING_TEXT;
            connectBtn.style.pointerEvents = 'none';
        });
    }

    // ─── Upload ───
    function setUploadButtonBusy(busy, text) {
        if (!uploadBtn) return;
        uploadBtn.disabled = busy;
        if (uploadBtnText) uploadBtnText.textContent = text || (busy ? 'Uploading…' : 'Upload to YouTube');
        if (uploadBtnSpinner) uploadBtnSpinner.style.display = busy ? 'inline-block' : 'none';
    }

    if (videoFile) {
        videoFile.addEventListener('change', function () {
            if (videoFile.files && videoFile.files[0]) {
                var sizeMB = (videoFile.files[0].size / (1024 * 1024)).toFixed(1);
                if (videoInfo) videoInfo.textContent = 'Selected: ' + videoFile.files[0].name + ' (' + sizeMB + ' MB)';
            } else {
                if (videoInfo) videoInfo.textContent = '';
            }
        });
    }

    if (uploadForm) {
        uploadForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!sessionToken) {
                showErrorBanner('YouTube not connected. Please connect first.');
                return;
            }

            var file = videoFile ? videoFile.files[0] : null;
            var title = document.getElementById('video-title').value.trim();
            if (!file) {
                setUploadMessage('\u274C Please select a video file.', 'error');
                return;
            }
            if (!title) {
                setUploadMessage('\u274C Title is required.', 'error');
                return;
            }

            setUploadButtonBusy(true, 'Uploading…');
            setUploadMessage('\u23F3 Upload starting…', 'info');

            try {
                var formData = new FormData();
                formData.append('video', file);
                formData.append('title', title);
                formData.append('description', document.getElementById('video-description').value.trim());
                formData.append('tags', document.getElementById('video-tags').value.trim());
                formData.append('category', document.getElementById('video-category').value);
                formData.append('privacyStatus', document.getElementById('video-privacy').value);
                formData.append('madeForKids', document.getElementById('made-for-kids').checked ? 'true' : 'false');

                var res = await fetch(BACKEND + '/api/youtube/upload', {
                    method: 'POST',
                    headers: authHeaders(),
                    credentials: 'include',
                    body: formData
                });
                var data = await res.json();

                if (!res.ok) {
                    setUploadMessage('\u274C ' + (data.error || 'Upload failed.'), 'error');
                    setUploadButtonBusy(false);
                    return;
                }

                setUploadMessage(
                    '\u2705 Upload complete! Video ID: <strong>' + escapeHtml(data.video_id) + '</strong> — ' +
                    '<a href="' + escapeHtml(data.video_url) + '" target="_blank" rel="noopener">View on YouTube</a>' +
                    ' (Status: ' + escapeHtml(data.privacy_status) + ')',
                    'success'
                );
                uploadForm.reset();
                if (videoInfo) videoInfo.textContent = '';
                setUploadButtonBusy(false);
                setUploadMessage('Processing…', 'info');

                pollVideoStatus(data.video_id);
            } catch (err) {
                setUploadMessage('\u274C Could not reach the server. ' + (err.message || ''), 'error');
                setUploadButtonBusy(false);
            }
        });
    }

    function setUploadMessage(html, type) {
        if (!uploadResult) return;
        uploadResult.style.display = 'block';
        uploadResult.className = 'yt-upload-result yt-upload-' + (type || 'info');
        uploadResult.innerHTML = html || '';
    }

    // ─── Poll video processing status ───
    async function pollVideoStatus(videoId) {
        var pollCount = 0;
        var maxPolls = 30;

        while (pollCount < maxPolls) {
            await new Promise(function (r) { setTimeout(r, 3000); });
            pollCount++;

            try {
                var res = await fetch(BACKEND + '/api/youtube/video-status/' + videoId, {
                    headers: authHeaders(),
                    credentials: 'include'
                });
                var data = await res.json();

                if (data.processing_status === 'succeeded') {
                    setUploadMessage('<br>\u2705 Processing complete!', 'success');
                    return;
                }
                if (data.processing_status === 'failed') {
                    setUploadMessage('<br>\u274C Processing failed: ' + escapeHtml(data.failure_reason || 'Unknown'), 'error');
                    return;
                }

                setUploadMessage('\u23F3 Processing… (attempt ' + pollCount + '/' + maxPolls + ')', 'info');
            } catch {
                // ignore polling errors
            }
        }
        setUploadMessage('\u23F3 Still processing — check YouTube directly.', 'info');
    }

    // ─── Disconnect confirmation modal ───
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', function () {
            if (disconnectModal) disconnectModal.style.display = 'flex';
        });
    }

    function closeDisconnectModal() {
        if (disconnectModal) disconnectModal.style.display = 'none';
    }

    if (disconnectCancelBtn) {
        disconnectCancelBtn.addEventListener('click', closeDisconnectModal);
    }

    if (disconnectModal) {
        disconnectModal.addEventListener('click', function (e) {
            if (e.target === disconnectModal) closeDisconnectModal();
        });
    }

    if (disconnectConfirmBtn) {
        disconnectConfirmBtn.addEventListener('click', async function () {
            if (!isBackendConfigured()) {
                closeDisconnectModal();
                showErrorBanner('Backend URL not configured.');
                return;
            }

            closeDisconnectModal();
            if (connectBtn) {
                connectBtn.textContent = 'Disconnecting…';
                connectBtn.style.pointerEvents = 'none';
            }

            try {
                var res = await fetch(BACKEND + '/api/youtube/disconnect', {
                    method: 'POST',
                    credentials: 'include',
                    headers: authHeaders({ 'Content-Type': 'application/json' })
                });
                var data = await res.json();

                if (data.disconnected) {
                    sessionToken = null;
                    localStorage.removeItem(SESSION_TOKEN_KEY);
                    showDisconnectedUI();
                } else {
                    showErrorBanner(data.error || 'Could not disconnect.');
                    showDisconnectedUI();
                }
            } catch (e) {
                showErrorBanner('Could not reach the server to disconnect.');
                showDisconnectedUI();
            }
        });
    }

    // ─── Init ───
    setLoading(true);
    updateConnectLinkForProduction();

    function updateConnectLinkForProduction() {
        if (!connectBtn) return;
        if (isBackendConfigured()) {
            connectBtn.href = BACKEND + '/youtube/auth';
        } else {
            connectBtn.href = '#';
            connectBtn.style.pointerEvents = 'none';
        }
    }

    // Entry point: handle handoff first if present, then only run a status
    // check when there was no handoff (i.e. plain page load/refresh with an
    // existing session token). This prevents a race where checkStatus() could
    // clear a freshly-issued session token before the handoff completes.
    (async function init() {
        var hadHandoff = await handleUrlParams();
        if (!hadHandoff) {
            await checkStatus();
        }
    })();
})();
