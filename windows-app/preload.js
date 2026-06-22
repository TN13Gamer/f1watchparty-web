(function() {
    function removeSandbox() {
        var iframes = document.getElementsByTagName('iframe');
        for (var i = 0; i < iframes.length; i++) {
            if (iframes[i].hasAttribute('sandbox')) {
                iframes[i].removeAttribute('sandbox');
                console.log('Electron Preload: Removed sandbox from iframe:', iframes[i].src);
            }
        }
    }
    
    try {
        var originalSetAttr = HTMLIFrameElement.prototype.setAttribute;
        HTMLIFrameElement.prototype.setAttribute = function(name, val) {
            if (name.toLowerCase() === 'sandbox') {
                console.log('Electron Preload: Intercepted and blocked setAttribute(sandbox)');
                this.removeAttribute('sandbox');
                return;
            }
            originalSetAttr.call(this, name, val);
        };
        
        Object.defineProperty(HTMLIFrameElement.prototype, 'sandbox', {
            get: function() {
                return this.getAttribute('sandbox') || '';
            },
            set: function(val) {
                console.log('Electron Preload: Intercepted and blocked sandbox property setter');
                this.removeAttribute('sandbox');
            },
            configurable: true,
            enumerable: true
        });
    } catch(e) { console.error('Electron Preload: error setting up sandbox overrides', e); }

    // Run when DOM content is loaded
    window.addEventListener('DOMContentLoaded', () => {
        removeSandbox();
        
        var observer = new MutationObserver(function(mutations) {
            removeSandbox();
        });
        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    });
})();
