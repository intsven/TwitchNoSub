(function () {

    let rewindButtonEl = null;
    let lastCheckedChannel = null;
    let rewindOverlay = null;
    let rewindOverlayInterval = null;
    let rewindHls = null;
    let hlsLoadPromise = null;
    let liveVideoRef = null;
    let liveVideoWasMuted = null;
    let rewindStylesInjected = false;
    let rewindFullscreenHandler = null;

    const RESERVED_PATHS = new Set([
        "directory", "settings", "subscriptions", "wallet", "drops", "friends",
        "inventory", "videos", "downloads", "turbo", "payments", "p", "moderator",
        "prime", "jobs", "team", "store", "search", "login", "signup"
    ]);

    function getChannelLogin() {
        const match = window.location.pathname.match(/^\/([a-zA-Z0-9_]{2,25})\/?$/);
        if (!match) return null;

        const login = match[1].toLowerCase();
        if (RESERVED_PATHS.has(login)) return null;

        return login;
    }

    async function findRecordingVod(channelLogin) {
        try {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: 'POST',
                body: JSON.stringify({
                    "query": `query { user(login: "${channelLogin}") { stream { id } videos(first: 1, type: ARCHIVE, sort: TIME) { edges { node { id status createdAt } } } } }`
                }),
                headers: {
                    'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            const data = await resp.json();
            const user = data && data.data && data.data.user;

            if (!user || !user.stream) {
                return null;
            }

            const edges = user.videos && user.videos.edges;
            if (!edges || edges.length === 0) {
                return null;
            }

            const video = edges[0].node;
            if (!video.status || video.status.toUpperCase() !== "RECORDING") {
                return null;
            }

            return video.id;
        } catch (e) {
            console.error("[TNS] Error looking up rewind VOD:", e);
            return null;
        }
    }

    async function getVodManifestUrl(vodId) {
        try {
            const resp = await fetch("https://gql.twitch.tv/gql", {
                method: 'POST',
                body: JSON.stringify({
                    "query": `query { video(id: "${vodId}") { seekPreviewsURL } }`
                }),
                headers: {
                    'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko',
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            });

            const data = await resp.json();
            const video = data && data.data && data.data.video;

            if (!video || !video.seekPreviewsURL) {
                return null;
            }

            const currentURL = new URL(video.seekPreviewsURL);
            const domain = currentURL.host;
            const paths = currentURL.pathname.split("/");
            const vodSpecialIndex = paths.findIndex(element => element.includes("storyboards"));

            if (vodSpecialIndex <= 0) {
                return null;
            }

            const vodSpecialID = paths[vodSpecialIndex - 1];

            return `https://${domain}/${vodSpecialID}/chunked/index-dvr.m3u8`;
        } catch (e) {
            console.error("[TNS] Error resolving rewind manifest:", e);
            return null;
        }
    }

    function loadHlsJs() {
        if (window.Hls) return Promise.resolve();
        if (hlsLoadPromise) return hlsLoadPromise;

        hlsLoadPromise = new Promise((resolve, reject) => {
            const url = localStorage.getItem('tns_hls_url');
            if (!url) {
                reject(new Error('hls.js URL not available'));
                return;
            }

            const script = document.createElement('script');
            script.src = url;
            script.onload = () => resolve();
            script.onerror = () => reject(new Error('Failed to load hls.js'));
            (document.head || document.documentElement).appendChild(script);
        });

        return hlsLoadPromise;
    }

    function getPlayerContainer() {
        return document.querySelector('[data-test-selector="video-player__video-container"]') ||
            document.querySelector('.video-player__container');
    }

    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) seconds = 0;
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        const pad = (n) => String(n).padStart(2, '0');
        return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }

    function injectRewindStyles() {
        if (rewindStylesInjected) return;
        rewindStylesInjected = true;

        const style = document.createElement('style');
        style.textContent = `
            .tns-rewind-video-wrap { position: relative; width: 100%; height: 100%; background: #000; overflow: hidden; }
            .tns-rewind-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; cursor: pointer; }
            .tns-rewind-controls {
                position: absolute; left: 0; right: 0; bottom: 0; z-index: 2;
                padding: 4px 12px 10px; background: linear-gradient(to top, rgba(0,0,0,0.85), rgba(0,0,0,0));
                opacity: 1; transition: opacity 0.2s ease; font-family: inherit;
            }
            .tns-rewind-controls.tns-hidden { opacity: 0; pointer-events: none; }
            .tns-rewind-seek-row { margin-bottom: 4px; }
            .tns-rewind-seek {
                -webkit-appearance: none; appearance: none; width: 100%; height: 4px; border-radius: 2px;
                outline: none; cursor: pointer; background: rgba(255,255,255,0.3); display: block;
            }
            .tns-rewind-seek::-webkit-slider-thumb {
                -webkit-appearance: none; width: 12px; height: 12px; border-radius: 50%; background: #9147ff; cursor: pointer;
            }
            .tns-rewind-seek::-moz-range-thumb { width: 12px; height: 12px; border: none; border-radius: 50%; background: #9147ff; cursor: pointer; }
            .tns-rewind-buttons-row { display: flex; align-items: center; justify-content: space-between; }
            .tns-rewind-buttons-left, .tns-rewind-buttons-right { display: flex; align-items: center; gap: 2px; }
            .tns-rewind-btn {
                background: transparent; border: none; color: #fff; cursor: pointer; padding: 6px; border-radius: 4px;
                display: flex; align-items: center; justify-content: center;
            }
            .tns-rewind-btn:hover { background: rgba(255,255,255,0.15); }
            .tns-rewind-volume {
                width: 60px; height: 4px; -webkit-appearance: none; appearance: none; border-radius: 2px;
                background: rgba(255,255,255,0.3); cursor: pointer; margin-left: 2px;
            }
            .tns-rewind-volume::-webkit-slider-thumb {
                -webkit-appearance: none; width: 10px; height: 10px; border-radius: 50%; background: #fff; cursor: pointer;
            }
            .tns-rewind-volume::-moz-range-thumb { width: 10px; height: 10px; border: none; border-radius: 50%; background: #fff; cursor: pointer; }
            .tns-rewind-time { color: #fff; font-size: 12px; margin-left: 8px; white-space: nowrap; }
            .tns-rewind-quality-menu {
                position: absolute; bottom: 42px; right: 8px; background: #18181b; border-radius: 4px; padding: 4px 0;
                min-width: 110px; box-shadow: 0 0 10px rgba(0,0,0,0.5); display: none; z-index: 3;
            }
            .tns-rewind-quality-menu.tns-open { display: block; }
            .tns-rewind-quality-item { padding: 6px 12px; color: #efeff1; font-size: 13px; cursor: pointer; white-space: nowrap; }
            .tns-rewind-quality-item:hover { background: rgba(255,255,255,0.1); }
            .tns-rewind-quality-item.tns-active { color: #a970ff; }
        `;
        document.head.appendChild(style);
    }

    function buildRewindControls(overlay, videoWrap, video, backButton) {
        const controls = document.createElement('div');
        controls.className = 'tns-rewind-controls';

        const seekRow = document.createElement('div');
        seekRow.className = 'tns-rewind-seek-row';
        const seek = document.createElement('input');
        seek.type = 'range';
        seek.className = 'tns-rewind-seek';
        seek.min = '0';
        seek.max = '100';
        seek.step = '0.01';
        seek.value = '0';
        let seeking = false;
        seek.addEventListener('input', () => {
            seeking = true;
            if (video.duration) {
                video.currentTime = (seek.value / 100) * video.duration;
            }
        });
        seek.addEventListener('change', () => { seeking = false; });
        seekRow.appendChild(seek);

        const buttonsRow = document.createElement('div');
        buttonsRow.className = 'tns-rewind-buttons-row';

        const left = document.createElement('div');
        left.className = 'tns-rewind-buttons-left';

        const PLAY_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"></path></svg>';
        const PAUSE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H5v16h5V4Zm9 0h-5v16h5V4Z"></path></svg>';

        const playBtn = document.createElement('button');
        playBtn.className = 'tns-rewind-btn';
        playBtn.innerHTML = PAUSE_ICON;
        playBtn.title = 'Pause';
        playBtn.addEventListener('click', () => {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
        });

        const MUTE_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12.146 2.857 7 8.004H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h3l5.146 5.146a.5.5 0 0 0 .854-.353V3.21a.5.5 0 0 0-.854-.354ZM20.5 15.5l-2-2-2 2L15 14l2-2-2-2 1.5-1.5 2 2 2-2L22 10l-2 2 2 2-1.5 1.5Z"></path></svg>';
        const VOLUME_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12.146 2.857 7 8.004H4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h3l5.146 5.146a.5.5 0 0 0 .854-.353V3.21a.5.5 0 0 0-.854-.354ZM16.243 7.757a6 6 0 0 1 0 8.486l-1.414-1.414a4 4 0 0 0 0-5.658l1.414-1.414ZM19.071 4.929a10 10 0 0 1 0 14.142l-1.414-1.414a8 8 0 0 0 0-11.314l1.414-1.414Z"></path></svg>';

        const muteBtn = document.createElement('button');
        muteBtn.className = 'tns-rewind-btn';
        muteBtn.innerHTML = VOLUME_ICON;
        muteBtn.title = 'Mute';
        muteBtn.addEventListener('click', () => {
            video.muted = !video.muted;
        });

        const volumeSlider = document.createElement('input');
        volumeSlider.type = 'range';
        volumeSlider.className = 'tns-rewind-volume';
        volumeSlider.min = '0';
        volumeSlider.max = '1';
        volumeSlider.step = '0.01';
        volumeSlider.value = String(video.volume);
        volumeSlider.addEventListener('input', () => {
            video.volume = parseFloat(volumeSlider.value);
            video.muted = video.volume === 0;
        });

        const timeText = document.createElement('span');
        timeText.className = 'tns-rewind-time';
        timeText.textContent = '0:00 / 0:00';

        left.appendChild(playBtn);
        left.appendChild(muteBtn);
        left.appendChild(volumeSlider);
        left.appendChild(timeText);

        const right = document.createElement('div');
        right.className = 'tns-rewind-buttons-right';

        const SETTINGS_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z"></path><path fill-rule="evenodd" d="M10.9 1h2.2v.228a3.362 3.362 0 0 0 5.739 2.378L19 3.444l1.556 1.555-.161.162a3.362 3.362 0 0 0 2.377 5.739H23v2.2h-.228a3.362 3.362 0 0 0-2.377 5.74l.161.16L19 20.557l-.16-.161a3.362 3.362 0 0 0-5.74 2.377V23h-2.2v-.228a3.362 3.362 0 0 0-5.74-2.377l-.16.16L3.444 19l.161-.16a3.362 3.362 0 0 0-2.377-5.74H1v-2.2h.228a3.362 3.362 0 0 0 2.377-5.739L3.445 5 5 3.444l.161.161A3.362 3.362 0 0 0 10.9 1.228V1ZM4.929 12 7 17l5 2.07L17 17l2.071-5L17 7l-5-2.071-5 2.07-2.071 5Z" clip-rule="evenodd"></path></svg>';

        const qualityWrap = document.createElement('div');
        qualityWrap.style.position = 'relative';

        const qualityBtn = document.createElement('button');
        qualityBtn.className = 'tns-rewind-btn';
        qualityBtn.innerHTML = SETTINGS_ICON;
        qualityBtn.title = 'Quality';

        const qualityMenu = document.createElement('div');
        qualityMenu.className = 'tns-rewind-quality-menu';

        qualityBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            qualityMenu.classList.toggle('tns-open');
        });

        qualityWrap.appendChild(qualityBtn);
        qualityWrap.appendChild(qualityMenu);

        const FULLSCREEN_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M8 3v2H3.996v4H2V3h6ZM2 15v6h6v-2H4v-4H2Zm18.002 0-.024 4H16v2h6v-6h-1.998ZM22 9V3h-5.993v2H20l.002 4H22Z"></path></svg>';
        const EXIT_FULLSCREEN_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M3.4 9.8H9.2V4H7v3.6H3.4V9.8ZM3.4 14.2H7V18h2.2v-6H3.4V14.2ZM14.8 4H16.9V7.6H20.6V9.8H14.8V4ZM16.9 18H14.8V14.2H20.6V16.4H16.9V18Z"></path></svg>';

        const fullscreenBtn = document.createElement('button');
        fullscreenBtn.className = 'tns-rewind-btn';
        fullscreenBtn.innerHTML = FULLSCREEN_ICON;
        fullscreenBtn.title = 'Fullscreen';
        fullscreenBtn.addEventListener('click', () => {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            } else {
                overlay.requestFullscreen().catch(() => {});
            }
        });

        rewindFullscreenHandler = () => {
            fullscreenBtn.innerHTML = document.fullscreenElement ? EXIT_FULLSCREEN_ICON : FULLSCREEN_ICON;
        };
        document.addEventListener('fullscreenchange', rewindFullscreenHandler);

        right.appendChild(qualityWrap);
        right.appendChild(fullscreenBtn);

        buttonsRow.appendChild(left);
        buttonsRow.appendChild(right);

        controls.appendChild(seekRow);
        controls.appendChild(buttonsRow);
        videoWrap.appendChild(controls);

        video.addEventListener('play', () => { playBtn.innerHTML = PAUSE_ICON; playBtn.title = 'Pause'; });
        video.addEventListener('pause', () => { playBtn.innerHTML = PLAY_ICON; playBtn.title = 'Play'; showControls(); });
        video.addEventListener('volumechange', () => {
            muteBtn.innerHTML = (video.muted || video.volume === 0) ? MUTE_ICON : VOLUME_ICON;
            volumeSlider.value = String(video.muted ? 0 : video.volume);
        });
        video.addEventListener('timeupdate', () => {
            if (!seeking && video.duration) {
                seek.value = String((video.currentTime / video.duration) * 100);
            }
            timeText.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;
        });
        video.addEventListener('durationchange', () => {
            timeText.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;
        });
        video.addEventListener('click', () => {
            if (video.paused) video.play().catch(() => {});
            else video.pause();
        });

        if (rewindHls) {
            const populateQualities = () => {
                qualityMenu.innerHTML = '';
                const levels = rewindHls.levels || [];

                const makeItem = (label, onClick, active) => {
                    const item = document.createElement('div');
                    item.className = 'tns-rewind-quality-item' + (active ? ' tns-active' : '');
                    item.textContent = label;
                    item.addEventListener('click', (e) => {
                        e.stopPropagation();
                        onClick();
                        qualityMenu.classList.remove('tns-open');
                    });
                    qualityMenu.appendChild(item);
                };

                makeItem('Auto', () => { rewindHls.currentLevel = -1; }, rewindHls.currentLevel === -1);
                levels.forEach((level, index) => {
                    const label = level.height ? `${level.height}p` : `Level ${index + 1}`;
                    makeItem(label, () => { rewindHls.currentLevel = index; }, rewindHls.currentLevel === index);
                });
            };

            rewindHls.on(window.Hls.Events.MANIFEST_PARSED, populateQualities);
            rewindHls.on(window.Hls.Events.LEVEL_SWITCHED, populateQualities);
        } else {
            qualityBtn.style.display = 'none';
        }

        let hideTimeout = null;
        const showControls = () => {
            controls.classList.remove('tns-hidden');
            backButton.style.opacity = '1';
            clearTimeout(hideTimeout);
            if (!video.paused) {
                hideTimeout = setTimeout(() => {
                    controls.classList.add('tns-hidden');
                    backButton.style.opacity = '0';
                }, 3000);
            }
        };

        overlay.addEventListener('click', (e) => {
            if (!qualityWrap.contains(e.target)) qualityMenu.classList.remove('tns-open');
        });
        overlay.addEventListener('mousemove', showControls);
        overlay.addEventListener('mouseleave', () => {
            if (!video.paused) {
                controls.classList.add('tns-hidden');
                backButton.style.opacity = '0';
            }
        });

        showControls();
    }

    function closeRewindOverlay() {
        if (rewindOverlayInterval) {
            clearInterval(rewindOverlayInterval);
            rewindOverlayInterval = null;
        }
        if (rewindFullscreenHandler) {
            document.removeEventListener('fullscreenchange', rewindFullscreenHandler);
            rewindFullscreenHandler = null;
        }
        if (rewindHls) {
            rewindHls.destroy();
            rewindHls = null;
        }
        if (rewindOverlay) {
            rewindOverlay.remove();
            rewindOverlay = null;
        }
        if (liveVideoRef) {
            liveVideoRef.muted = liveVideoWasMuted;
            liveVideoRef = null;
            liveVideoWasMuted = null;
        }
    }

    async function openRewindOverlay(vodId) {
        closeRewindOverlay();

        const container = getPlayerContainer();
        if (!container) return;

        const liveVideo = container.querySelector('video');
        if (liveVideo) {
            liveVideoRef = liveVideo;
            liveVideoWasMuted = liveVideo.muted;
            liveVideo.muted = true;
        }

        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.zIndex = '9999';
        overlay.style.backgroundColor = '#000';

        const statusText = document.createElement('div');
        statusText.textContent = 'Loading rewind...';
        statusText.style.position = 'absolute';
        statusText.style.top = '50%';
        statusText.style.left = '50%';
        statusText.style.transform = 'translate(-50%, -50%)';
        statusText.style.color = '#fff';
        statusText.style.fontSize = '14px';
        statusText.style.textAlign = 'center';
        statusText.style.width = '80%';
        statusText.style.zIndex = '10';

        const backButton = document.createElement('button');
        backButton.textContent = '← Back to live';
        backButton.style.position = 'absolute';
        backButton.style.top = '10px';
        backButton.style.left = '10px';
        backButton.style.zIndex = '10000';
        backButton.style.padding = '6px 12px';
        backButton.style.background = 'rgba(0, 0, 0, 0.7)';
        backButton.style.color = '#fff';
        backButton.style.border = '1px solid #fff';
        backButton.style.borderRadius = '4px';
        backButton.style.cursor = 'pointer';
        backButton.style.fontSize = '13px';
        backButton.style.transition = 'opacity 0.2s ease';
        backButton.addEventListener('click', closeRewindOverlay);

        overlay.appendChild(statusText);
        overlay.appendChild(backButton);
        document.body.appendChild(overlay);
        rewindOverlay = overlay;

        const syncPosition = () => {
            const rect = container.getBoundingClientRect();
            overlay.style.top = `${rect.top}px`;
            overlay.style.left = `${rect.left}px`;
            overlay.style.width = `${rect.width}px`;
            overlay.style.height = `${rect.height}px`;
        };

        syncPosition();
        rewindOverlayInterval = setInterval(syncPosition, 300);

        let manifestUrl;
        try {
            [manifestUrl] = await Promise.all([
                getVodManifestUrl(vodId),
                loadHlsJs()
            ]);
        } catch (e) {
            console.error("[TNS] Failed to prepare rewind playback:", e);
            if (rewindOverlay === overlay) {
                statusText.textContent = 'Failed to load rewind.';
            }
            return;
        }

        if (rewindOverlay !== overlay) return; // overlay was closed while loading

        if (!manifestUrl) {
            statusText.textContent = "Rewind not available yet (VOD not ready, try again in a few moments).";
            return;
        }

        injectRewindStyles();

        const videoWrap = document.createElement('div');
        videoWrap.className = 'tns-rewind-video-wrap';

        const video = document.createElement('video');
        video.className = 'tns-rewind-video';
        video.autoplay = true;
        video.playsInline = true;

        videoWrap.appendChild(video);
        overlay.insertBefore(videoWrap, backButton);

        if (window.Hls && window.Hls.isSupported()) {
            const hls = new window.Hls();
            hls.on(window.Hls.Events.ERROR, (event, data) => {
                if (data.fatal && rewindOverlay === overlay) {
                    console.error("[TNS] HLS fatal error:", data);
                    statusText.textContent = 'Playback error.';
                    statusText.style.display = 'block';
                }
            });
            hls.loadSource(manifestUrl);
            hls.attachMedia(video);
            rewindHls = hls;
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = manifestUrl;
        } else {
            statusText.textContent = "Your browser does not support rewind playback.";
            return;
        }

        statusText.style.display = 'none';
        buildRewindControls(overlay, videoWrap, video, backButton);
    }

    function createRewindButton() {
        const channelLogin = getChannelLogin();
        if (!channelLogin) return;

        if (channelLogin === lastCheckedChannel && rewindButtonEl && document.body.contains(rewindButtonEl)) {
            return;
        }

        const controlsContainer = document.querySelector('.player-controls__right-control-group');

        if (!controlsContainer) {
            setTimeout(createRewindButton, 1000);
            return;
        }

        const rewindButton = document.createElement('button');
        rewindButton.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/>
            </svg>
        `;
        rewindButton.className = 'ScCoreButton-sc-ocjdkq-0 ScCoreButtonSecondary-sc-ocjdkq-2';
        rewindButton.style.marginLeft = '10px';
        rewindButton.style.opacity = '0.4';
        rewindButton.style.cursor = 'default';
        rewindButton.title = 'Rewind: checking...';
        rewindButton.disabled = true;

        controlsContainer.appendChild(rewindButton);
        rewindButtonEl = rewindButton;
        lastCheckedChannel = channelLogin;

        findRecordingVod(channelLogin).then(vodId => {
            if (rewindButtonEl !== rewindButton) return;

            if (vodId) {
                rewindButton.style.opacity = '1';
                rewindButton.style.cursor = 'pointer';
                rewindButton.disabled = false;
                rewindButton.title = 'Rewind: watch from the beginning';

                rewindButton.addEventListener('click', () => {
                    openRewindOverlay(vodId);
                });
            } else {
                rewindButton.title = 'Rewind unavailable (VODs not enabled for this channel)';
            }
        });

        console.log('TwitchNoSub: Rewind button added');
    }

    function checkAndAddButton() {
        const channelLogin = getChannelLogin();

        if (channelLogin) {
            if (channelLogin !== lastCheckedChannel) {
                rewindButtonEl = null;
            }
            createRewindButton();
        } else {
            rewindButtonEl = null;
            lastCheckedChannel = null;
            closeRewindOverlay();
        }
    }

    checkAndAddButton();

    const pushState = history.pushState;
    history.pushState = function () {
        pushState.apply(history, arguments);
        closeRewindOverlay();
        setTimeout(checkAndAddButton, 1000);
    };

    window.addEventListener('popstate', () => {
        closeRewindOverlay();
        setTimeout(checkAndAddButton, 1000);
    });

    setInterval(checkAndAddButton, 5000);
})();
