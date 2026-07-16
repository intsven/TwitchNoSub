function injectScript(src) {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL(src);
    s.onload = () => s.remove();
    (document.head || document.documentElement).append(s);
}

localStorage.setItem("tns_hls_url", chrome.runtime.getURL("src/hls.min.js"));

injectScript("src/app.js");
injectScript("src/download.js");
injectScript("src/rewind.js");