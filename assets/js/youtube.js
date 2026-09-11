/**
 * Modern Living Hub — YouTube Integration Frontend
 * Handles OAuth handoff, session token, channel info, video upload,
 * and processing status via the server-side YouTube backend API.
 *
 * Cross-site architecture (same as Pinterest/TikTok):
 *   1. Backend redirects to this page with ?youtube_connected=1&yt_handoff=<CODE>
 *   2. Frontend POSTs handoff code to /api/youtube/complete
 *   3. Backend returns a bearer session_token
 *   4. All subsequent API calls use Authorization: Bearer <session_token>
 */

(function () {
    'use strict';

    var BACKEND = (window.BACKEND_URL || '').replace(/\/+$/, '');
    var SESSION_TOKEN_KEY = 'mlh_youtube_session_token';
    var sessionToken = localStorage.getItem(SESSION_TOKEN_KEY) || null;

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

    function showError(el, msg) {
        if (!el) return;
        el.textContent = '\u26A0\uFE0F ' + msg;
        el.style.display = 'block';
    }

    function escapeHtml(text) {
        var div = document.createElement('div');
        div.appendChild(document.createTextNode(text));
        return div.innerHTML;
    }

    // ─── DOM references ───
    var connectBtn = document.getElementById('connect-youtube-btn');
    var connectedState = document.getElementById('connected-state');
    var disconnectedState = document.getElementById('disconnected-state');
    var channelInfo = document.getElementById('channel-info');
    var uploadForm = document.getElementById('upload-form');
    var uploadResult = document.getElementById('upload-result');
    var disconnectError = document.getElementById('disconnect-error');
    var videoFile = document.getElementById('video-file');
    var videoInfo = document.getElementById('video-info');

    function updateConnectLinks() {
        var url = isBackendConfigured() ? BACKEND + '/youtube/auth' : '#';
        if (connectBtn) connectBtn.href = url;
        if (!isBackendConfigured() && connectBtn) {
            connectBtn.style.pointerEvents = 'none';
            connectBtn.style.opacity = '0.5';
        }
    }

    function showConnectedUI() {
        if (connectBtn) {
            connectBtn.textContent = '\u2705 Connected';
            connectBtn.href = '#';
            connectBtn.style.pointerEvents = 'none';
            connectBtn.style.opacity = '0.6';
        }
        if (connectedState) connectedState.style.display = 'block';
        if (disconnectedState) disconnectedState.style.display = 'none';
        loadChannelInfo();
    }

    function showDisconnectedUI() {
        if (connectBtn) {
            connectBtn.textContent = '\u25B6\uFE0F Connect YouTube';
            connectBtn.href = isBackendConfigured() ? BACKEND + '/youtube/auth' : '#';
            connectBtn.style.pointerEvents = isBackendConfigured() ? '' : 'none';
            connectBtn.style.opacity = isBackendConfigured() ? '' : '0.5';
        }
        if (connectedState) connectedState.style.display = 'none';
        if (disconnectedState) disconnectedState.style.display = 'block';
        if (channelInfo) channelInfo.innerHTML = '<p>Not connected.</p>';
    }

    // ─── Complete handoff ───
    async function completeYTHandoff(code) {
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
                showError(disconnectError, data.error || 'Could not complete YouTube connection.');
                showDisconnectedUI();
                return false;
            }
        } catch (e) {
            showError(disconnectError, 'Could not reach the server to complete YouTube connection.');
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
            window.history.replaceState({}, '', window.location.pathname);
            await completeYTHandoff(handoff);
            return;
        }

        if (error) {
            window.history.replaceState({}, '', window.location.pathname);
            showError(disconnectError, 'YouTube connection failed: ' + decodeURIComponent(error));
        }
    }

    // ─── Check connection status ───
    async function checkStatus() {
        if (!isBackendConfigured()) {
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
                sessionToken = null;
                localStorage.removeItem(SESSION_TOKEN_KEY);
                showDisconnectedUI();
            }
        } catch {
            showDisconnectedUI();
        }
    }

    // ─── Load channel info ───
    async function loadChannelInfo() {
        if (!channelInfo) return;
        if (!isBackendConfigured()) return;
        try {
            var res = await fetch(BACKEND + '/api/youtube/channel', {
                headers: authHeaders(),
                credentials: 'include'
            });
            var data = await res.json();
            if (data.channel) {
                var ch = data.channel;
                channelInfo.innerHTML =
                    '<p><strong>' + escapeHtml(ch.title) + '</strong></p>' +
                    '<p style="font-size:0.85rem;color:var(--color-text-light);">' +
                    'Channel ID: ' + escapeHtml(ch.id) + '</p>' +
                    (ch.description ? '<p style="font-size:0.85rem;">' + escapeHtml(ch.description).substring(0, 200) + '</p>' : '');
            } else {
                channelInfo.innerHTML = '<p>No channel information available.</p>';
            }
        } catch {
            channelInfo.innerHTML = '<p>Could not load channel information.</p>';
        }
    }

    // ─── Video file preview ───
    if (videoFile) {
        videoFile.addEventListener('change', function () {
            var file = this.files && this.files[0];
            if (!file) return;
            if (videoInfo) {
                var sizeMB = (file.size / (1024 * 1024)).toFixed(2);
                videoInfo.textContent = file.name + ' (' + sizeMB + ' MB)';
            }
        });
    }

    // ─── Upload ───
    if (uploadForm) {
        uploadForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!isBackendConfigured()) return;

            var title = document.getElementById('video-title').value.trim();
            var file = videoFile && videoFile.files && videoFile.files[0];

            if (!file) {
                uploadResult.textContent = '\u274C Please select a video file.';
                uploadResult.style.color = 'var(--color-error)';
                return;
            }
            if (!title) {
                uploadResult.textContent = '\u274C Title is required.';
                uploadResult.style.color = 'var(--color-error)';
                return;
            }

            uploadResult.textContent = '\u23F3 Uploading video…';
            uploadResult.style.color = 'var(--color-text-light)';
            document.getElementById('upload-btn').disabled = true;

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
                    uploadResult.textContent = '\u274C ' + (data.error || 'Upload failed.');
                    uploadResult.style.color = 'var(--color-error)';
                    return;
                }

                uploadResult.innerHTML = '\u2705 Video uploaded! Video ID: <strong>' +
                    escapeHtml(data.video_id) + '</strong> — ' +
                    '<a href="' + escapeHtml(data.video_url) + '" target="_blank" rel="noopener">View on YouTube</a>' +
                    ' (Status: ' + escapeHtml(data.privacy_status) + ')';
                uploadResult.style.color = 'var(--color-success)';
                uploadForm.reset();
                if (videoInfo) videoInfo.textContent = '';

                // Poll processing status
                pollVideoStatus(data.video_id);
            } catch (err) {
                uploadResult.textContent = '\u274C Could not reach the server. ' + (err.message || '');
                uploadResult.style.color = 'var(--color-error)';
            } finally {
                document.getElementById('upload-btn').disabled = false;
            }
        });
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
                    uploadResult.innerHTML += '<br>\u2705 Processing complete!';
                    return;
                }
                if (data.processing_status === 'failed') {
                    uploadResult.innerHTML += '<br>\u274C Processing failed: ' + escapeHtml(data.failure_reason || 'Unknown');
                    return;
                }

                uploadResult.innerHTML += '<br>\u23F3 Processing… (attempt ' + pollCount + '/' + maxPolls + ')';
            } catch {
                // ignore polling errors
            }
        }
        uploadResult.innerHTML += '<br>\u23F3 Still processing — check YouTube directly.';
    }

    // ─── Disconnect ───
    var disconnectBtn = document.getElementById('disconnect-youtube-btn');
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async function () {
            if (!isBackendConfigured()) return;
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
                    showError(disconnectError, 'Could not disconnect.');
                }
            } catch {
                showError(disconnectError, 'Could not reach the server.');
            }
        });
    }

    // ─── Init ───
    updateConnectLinks();
    handleUrlParams().then(function () {
        checkStatus();
    });
})();
