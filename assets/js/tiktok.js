/**
 * Modern Living Hub — TikTok Integration Frontend
 * Handles OAuth handoff, session token, creator info, video posting,
 * and processing status via the server-side TikTok backend API.
 *
 * Cross-site architecture (same as Pinterest):
 *   1. Backend redirects to this page with ?tiktok_connected=1&tt_handoff=<CODE>
 *   2. Frontend POSTs handoff code to /api/tiktok/complete
 *   3. Backend returns a bearer session_token
 *   4. All subsequent API calls use Authorization: Bearer <session_token>
 */

(function () {
    'use strict';

    var BACKEND = (window.BACKEND_URL || '').replace(/\/+$/, '');
    var SESSION_TOKEN_KEY = 'mlh_tiktok_session_token';
    var sessionToken = localStorage.getItem(SESSION_TOKEN_KEY) || null;

    function isBackendConfigured() {
        return Boolean(BACKEND) && !BACKEND.includes('YOUR-BACKEND');
    }

    function authHeaders(extra) {
        var headers = Object.assign({}, extra || {});
        if (sessionToken) headers['Authorization'] = 'Bearer ' + sessionToken;
        return headers;
    }

    // ─── DOM references ───
    var connectBtn = document.getElementById('connect-tiktok-btn');
    var statusBanner = document.getElementById('tiktok-status');
    var connectedState = document.getElementById('connected-state');
    var disconnectedState = document.getElementById('disconnected-state');
    var creatorInfo = document.getElementById('creator-info');
    var postForm = document.getElementById('post-form');
    var postResult = document.getElementById('post-result');
    var disconnectError = document.getElementById('disconnect-error');
    var videoFile = document.getElementById('video-file');
    var videoPreview = document.getElementById('video-preview');
    var videoConstraints = document.getElementById('video-constraints');
    var previewInfo = document.getElementById('preview-info');
    var privacySelect = document.getElementById('privacy-level');

    function updateConnectLinks() {
        var url = isBackendConfigured() ? BACKEND + '/tiktok/auth' : '#';
        if (connectBtn) connectBtn.href = url;
        if (!isBackendConfigured() && connectBtn) {
            connectBtn.style.pointerEvents = 'none';
            connectBtn.style.opacity = '0.5';
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
        loadCreatorInfo();
    }

    function showDisconnectedUI() {
        if (connectBtn) {
            connectBtn.textContent = '🎵 Connect TikTok';
            connectBtn.href = isBackendConfigured() ? BACKEND + '/tiktok/auth' : '#';
            connectBtn.style.pointerEvents = isBackendConfigured() ? '' : 'none';
            connectBtn.style.opacity = isBackendConfigured() ? '' : '0.5';
        }
        if (statusBanner) statusBanner.style.display = 'none';
        if (connectedState) connectedState.style.display = 'none';
        if (disconnectedState) disconnectedState.style.display = 'block';
        if (creatorInfo) creatorInfo.innerHTML = '<p>Not connected.</p>';
    }

    // ─── Complete handoff ───
    async function completeTTHandoff(code) {
        try {
            var res = await fetch(BACKEND + '/api/tiktok/complete', {
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
                showError(disconnectError, data.error || 'Could not complete TikTok connection.');
                showDisconnectedUI();
                return false;
            }
        } catch (e) {
            showError(disconnectError, 'Could not reach the server to complete TikTok connection.');
            showDisconnectedUI();
            return false;
        }
    }

    // ─── Handle OAuth return params ───
    async function handleUrlParams() {
        var params = new URLSearchParams(window.location.search);
        var handoff = params.get('tt_handoff');
        var error = params.get('tiktok_error');

        if (params.get('tiktok_connected') === '1' && handoff) {
            window.history.replaceState({}, '', window.location.pathname);
            await completeTTHandoff(handoff);
            return;
        }
        if (params.get('tiktok_connected') === '1') {
            window.history.replaceState({}, '', window.location.pathname);
        }
        if (error) {
            window.history.replaceState({}, '', window.location.pathname);
            showError(disconnectError, decodeURIComponent(error));
        }
    }

    // ─── Status check ───
    async function checkStatus() {
        if (!isBackendConfigured()) {
            showError(disconnectError, 'Backend not configured. Set window.BACKEND_URL in the page source.');
            showDisconnectedUI();
            return;
        }
        try {
            var res = await fetch(BACKEND + '/api/tiktok/status', {
                credentials: 'include',
                headers: authHeaders()
            });
            var data = await res.json();
            if (data.connected) {
                showConnectedUI();
            } else {
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

    // ─── Load creator info ───
    async function loadCreatorInfo() {
        if (!creatorInfo || !isBackendConfigured()) return;
        creatorInfo.innerHTML = '<p>Loading creator information…</p>';
        try {
            var res = await fetch(BACKEND + '/api/tiktok/creator', {
                credentials: 'include',
                headers: authHeaders()
            });
            var data = await res.json();
            if (res.status === 401) {
                creatorInfo.innerHTML = '<p style="color:var(--color-error);">Not connected.</p>';
                return;
            }
            if (!res.ok) {
                creatorInfo.innerHTML = '<p style="color:var(--color-error);">⚠️ ' + escapeHtml(data.error || 'Could not load creator info') + '</p>';
                return;
            }

            // Update privacy options from TikTok
            // Keep the "Select privacy setting" placeholder; user must choose explicitly.
            if (data.privacy_level_options && data.privacy_level_options.length > 0 && privacySelect) {
                var currentVal = privacySelect.value;
                privacySelect.innerHTML = '';
                var placeholder = document.createElement('option');
                placeholder.value = '';
                placeholder.disabled = true;
                placeholder.selected = true;
                placeholder.textContent = 'Select privacy setting';
                privacySelect.appendChild(placeholder);
                data.privacy_level_options.forEach(function (opt) {
                    var o = document.createElement('option');
                    o.value = opt;
                    o.textContent = opt.replace(/_/g, ' ');
                    privacySelect.appendChild(o);
                });
                if (currentVal && Array.from(privacySelect.options).some(function (o) { return o.value === currentVal; })) {
                    privacySelect.value = currentVal;
                }
            }

            // Show creator info
            var html = '';
            if (data.creator_nickname || data.creator_username) {
                html += '<p><strong>' + escapeHtml(data.creator_nickname || data.creator_username) + '</strong>';
                if (data.creator_username) html += ' (@' + escapeHtml(data.creator_username) + ')';
                html += '</p>';
            }
            if (data.max_video_post_duration_sec) {
                var mins = Math.floor(data.max_video_post_duration_sec / 60);
                var secs = data.max_video_post_duration_sec % 60;
                html += '<p style="font-size:0.9rem;">Max video duration: <strong>' + mins + ':' + (secs < 10 ? '0' : '') + secs + '</strong></p>';
                if (videoConstraints) {
                    videoConstraints.textContent = 'Max duration: ' + mins + ':' + (secs < 10 ? '0' : '') + secs;
                }
            }
            if (data.max_video_size) {
                var sizeMB = (data.max_video_size / (1024 * 1024)).toFixed(1);
                html += '<p style="font-size:0.9rem;">Max file size: <strong>' + sizeMB + ' MB</strong></p>';
                if (videoConstraints) {
                    videoConstraints.textContent += ' · Max size: ' + sizeMB + ' MB';
                }
            }
            if (data.can_post === false) {
                html += '<p style="color:var(--color-error);">⚠️ Your account cannot post videos at this time.</p>';
            }
            html += '<p style="font-size:0.85rem; color:var(--color-text-light);">Account ID: ' + escapeHtml(data.open_id || 'N/A') + '</p>';
            creatorInfo.innerHTML = html || '<p>Creator information loaded.</p>';
        } catch {
            creatorInfo.innerHTML = '<p style="color:var(--color-error);">Could not load creator information.</p>';
        }
    }

    // ─── Video file preview ───
    if (videoFile) {
        videoFile.addEventListener('change', function () {
            var file = this.files && this.files[0];
            if (!file) return;
            if (videoPreview) {
                videoPreview.src = URL.createObjectURL(file);
                videoPreview.style.display = 'block';
            }
            if (previewInfo) {
                var sizeMB = (file.size / (1024 * 1024)).toFixed(2);
                previewInfo.textContent = file.name + ' (' + sizeMB + ' MB)';
            }
        });
    }

    // ─── TikTok declaration (Content Sharing Guidelines) ───
    var confirmNote = document.getElementById('confirm-note');
    var brandToggle = document.getElementById('brand-content-toggle');

    function updatePostDeclaration() {
        if (!confirmNote) return;
        var isPaidPartnership = brandToggle ? brandToggle.checked : false;
        confirmNote.textContent = isPaidPartnership
            ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
            : "By posting, you agree to TikTok's Music Usage Confirmation.";
    }

    if (brandToggle) {
        brandToggle.addEventListener('change', updatePostDeclaration);
    }
    updatePostDeclaration();

    // ─── Post to TikTok ───
    if (postForm) {
        postForm.addEventListener('submit', async function (e) {
            e.preventDefault();
            if (!isBackendConfigured()) return;

            var title = document.getElementById('video-title').value.trim();
            var file = videoFile && videoFile.files && videoFile.files[0];
            var privacy = privacySelect ? privacySelect.value : '';
            var disableDuet = document.getElementById('disable-duet') ? document.getElementById('disable-duet').checked : false;
            var disableComment = document.getElementById('disable-comment') ? document.getElementById('disable-comment').checked : false;
            var disableStitch = document.getElementById('disable-stitch') ? document.getElementById('disable-stitch').checked : false;

            if (!title) {
                postResult.textContent = '❌ Caption is required.';
                postResult.style.color = 'var(--color-error)';
                return;
            }
            if (!file) {
                postResult.textContent = '❌ Please select a video file.';
                postResult.style.color = 'var(--color-error)';
                return;
            }
            if (!privacy) {
                postResult.textContent = '❌ Please select a privacy setting.';
                postResult.style.color = 'var(--color-error)';
                return;
            }

            // Step 1: Initialize TikTok post
            postResult.textContent = '🔄 Initializing post…';
            postResult.style.color = 'var(--color-text-light)';

            try {
                var initRes = await fetch(BACKEND + '/api/tiktok/post/init', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    credentials: 'include',
                    body: JSON.stringify({
                        title: title,
                        privacy_level: privacy,
                        disable_duet: disableDuet,
                        disable_comment: disableComment,
                        disable_stitch: disableStitch,
                        brand_content_toggle: document.getElementById('brand-content-toggle') ? document.getElementById('brand-content-toggle').checked : false,
                        video_size: file.size
                    })
                });
                var initData = await initRes.json();

                if (!initRes.ok) {
                    postResult.textContent = '❌ ' + (initData.error || 'Failed to initialize TikTok post.');
                    postResult.style.color = 'var(--color-error)';
                    return;
                }

                if (!initData.upload_url) {
                    postResult.textContent = '❌ TikTok did not provide an upload URL.';
                    postResult.style.color = 'var(--color-error)';
                    return;
                }

                // Step 2: Upload video (base64 → server → PUT to TikTok)
                postResult.textContent = '📤 Uploading video…';
                postResult.style.color = 'var(--color-text-light)';

                var videoBuffer = await file.arrayBuffer();
                var videoBase64 = btoa(String.fromCharCode.apply(null, new Uint8Array(videoBuffer)));

                var uploadRes = await fetch(BACKEND + '/api/tiktok/post/upload', {
                    method: 'POST',
                    headers: authHeaders({ 'Content-Type': 'application/json' }),
                    credentials: 'include',
                    body: JSON.stringify({ upload_url: initData.upload_url, video_data: videoBase64, video_size: file.size })
                });
                var uploadData = await uploadRes.json();

                if (!uploadRes.ok) {
                    postResult.textContent = '❌ ' + (uploadData.error || 'Video upload failed.');
                    postResult.style.color = 'var(--color-error)';
                    return;
                }

                // Step 3: Check processing status
                postResult.textContent = '⏳ Processing video…';
                postResult.style.color = 'var(--color-text-light)';

                var pollCount = 0;
                var maxPolls = 30;
                var publishId = initData.publish_id;

                while (pollCount < maxPolls) {
                    await new Promise(function (r) { setTimeout(r, 2000); });
                    pollCount++;

                    var statusRes = await fetch(BACKEND + '/api/tiktok/post/status', {
                        method: 'POST',
                        headers: authHeaders({ 'Content-Type': 'application/json' }),
                        credentials: 'include',
                        body: JSON.stringify({ publish_id: publishId })
                    });
                    var statusData = await statusRes.json();

                    if (statusData.status === 'SUCCESS') {
                        postResult.innerHTML = '✅ Video posted successfully! <a href="' + escapeHtml(statusData.post_url || '#') + '" target="_blank" rel="noopener">View on TikTok</a>';
                        postResult.style.color = 'var(--color-success)';
                        postForm.reset();
                        if (videoPreview) { videoPreview.style.display = 'none'; videoPreview.src = ''; }
                        if (previewInfo) previewInfo.textContent = '';
                        return;
                    }
                    if (statusData.status === 'FAILED') {
                        postResult.textContent = '❌ TikTok rejected the video: ' + (statusData.error_msg || 'Processing failed.');
                        postResult.style.color = 'var(--color-error)';
                        return;
                    }
                    if (statusData.status === 'NOT_FOUND') {
                        postResult.textContent = '❌ Publishing request not found.';
                        postResult.style.color = 'var(--color-error)';
                        return;
                    }
                    postResult.textContent = '⏳ Processing… (attempt ' + pollCount + '/' + maxPolls + ')';
                }

                postResult.textContent = '⏳ Still processing — check TikTok directly for the result.';
                postResult.style.color = 'var(--color-text-light)';
            } catch (err) {
                postResult.textContent = '❌ Could not reach the server. ' + (err.message || '');
                postResult.style.color = 'var(--color-error)';
            }
        });
    }

    // ─── Disconnect ───
    var disconnectBtn = document.getElementById('disconnect-tiktok-btn');
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async function () {
            if (!isBackendConfigured()) return;
            try {
                var res = await fetch(BACKEND + '/api/tiktok/disconnect', {
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
                showError(disconnectError, 'Could not reach the server to disconnect.');
            }
        });
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
