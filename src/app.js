if (!window.__twitchNoSubAppLoaded) {
    window.__twitchNoSubAppLoaded = true;

    let isVariantA = false;
    const originalAppendChild = document.head.appendChild;

    document.head.appendChild = function (element) {
        if (element.tagName === "SCRIPT") {
            if (element.src.includes("player-core-variant-a")) {
                isVariantA = true;
            }
        }

        return originalAppendChild.call(this, element);
    };

    const oldWorker = window.Worker;

    window.Worker = class Worker extends oldWorker {
        constructor(twitchBlobUrl) {
            super(twitchBlobUrl);

            this.addEventListener("message", (event) => {
                const data = event.data;

                if ((data.id == 1 || isVariantA) && data.type == 1) {
                    const newData = event.data;

                    newData.arg = [data.arg];

                    try {
                        this.postMessage(newData);
                    } catch (err) {
                        if (err instanceof DOMException && err.name === "DataCloneError") {
                            try {
                                this.postMessage(newData, [data.arg]);
                            } catch (retryErr) {
                                console.error("TwitchNoSub: failed to relay worker message", retryErr);
                            }
                        } else {
                            throw err;
                        }
                    }
                }
            });
        }
    }
}