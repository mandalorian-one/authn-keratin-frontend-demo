(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.KeratinAuthN = {}));
}(this, (function (exports) { 'use strict';

    // takes a simple map, returns a string
    function formData(data) {
        return Object.keys(data)
            .map(function (k) { return formDataItem(k, data[k]); })
            .filter(function (str) { return str !== undefined; })
            .join("&");
    }
    function formDataItem(k, v) {
        if (typeof v !== "undefined") {
            return k + "=" + encodeURIComponent(v);
        }
    }

    function get(url, data) {
        return jhr(function (xhr) {
            xhr.open("GET", (url + "?" + formData(data)).replace(/\?$/, ""));
            xhr.send();
        });
    }
    function del(url) {
        return jhr(function (xhr) {
            xhr.open("DELETE", url);
            xhr.send();
        });
    }
    function post(url, data) {
        return jhr(function (xhr) {
            xhr.open("POST", url);
            xhr.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
            xhr.send(formData(data));
        });
    }
    function jhr(sender) {
        return new Promise(function (fulfill, reject) {
            var xhr = new XMLHttpRequest();
            xhr.withCredentials = true; // enable authentication server cookies
            xhr.onreadystatechange = function () {
                if (xhr.readyState === XMLHttpRequest.DONE) {
                    var data = xhr.responseText.length > 1 ? JSON.parse(xhr.responseText) : {};
                    if ("errors" in data) {
                        reject(data.errors);
                    }
                    else if (xhr.status > 400) {
                        // statusText may be missing in HTTP/2. only the status number is reliable.
                        reject([{ message: xhr.status.toString() }]);
                    }
                    else {
                        fulfill(data.result);
                    }
                }
            };
            sender(xhr);
        });
    }

    /*
     * Bare API methods have no local side effects (unless you count debouncing).
     */
    // TODO: extract debouncing
    var inflight = false;
    var ISSUER = "";
    function setHost(URL) {
        ISSUER = URL.replace(/\/$/, "");
    }
    function signup$1(credentials) {
        return new Promise(function (fulfill, reject) {
            if (inflight) {
                reject([{ message: "duplicate" }]);
                return;
            }
            else {
                inflight = true;
            }
            post(url("/accounts"), credentials)
                .then(function (result) { return fulfill(result.id_token); }, function (errors) { return reject(errors); })
                .then(function () { return (inflight = false); });
        });
    }
    function isTaken(e) {
        return e.field === "username" && e.message === "TAKEN";
    }
    function isAvailable(username) {
        return get(url("/accounts/available"), { username: username })
            .then(function (bool) { return bool; })
            .catch(function (e) {
            if (!(e instanceof Error) && e.some(isTaken)) {
                return false;
            }
            throw e;
        });
    }
    function refresh() {
        return get(url("/session/refresh"), {}).then(function (result) { return result.id_token; });
    }
    function login$1(credentials) {
        return post(url("/session"), credentials).then(function (result) { return result.id_token; });
    }
    function logout$1() {
        return del(url("/session"));
    }
    function requestPasswordReset(username) {
        return get(url("/password/reset"), { username: username });
    }
    function changePassword$1(args) {
        return post(url("/password"), args).then(function (result) { return result.id_token; });
    }
    function resetPassword$1(args) {
        return post(url("/password"), args).then(function (result) { return result.id_token; });
    }
    function requestSessionToken(username) {
        return get(url("/session/token"), { username: username });
    }
    function sessionTokenLogin$1(credentials) {
        return post(url("/session/token"), credentials).then(function (result) { return result.id_token; });
    }
    function url(path) {
        if (!ISSUER.length) {
            throw "ISSUER not set";
        }
        return "" + ISSUER + path;
    }

    var JWTSession = /** @class */ (function () {
        function JWTSession(token) {
            this.token = token;
            this.claims = jwt_claims(token);
        }
        JWTSession.prototype.iat = function () {
            return this.claims.iat * 1000;
        };
        JWTSession.prototype.exp = function () {
            return this.claims.exp * 1000;
        };
        JWTSession.prototype.halflife = function () {
            return (this.exp() - this.iat()) / 2;
        };
        return JWTSession;
    }());
    function jwt_claims(jwt) {
        try {
            return JSON.parse(atob(jwt.split(".")[1]));
        }
        catch (e) {
            throw "Malformed JWT: invalid encoding";
        }
    }

    var SessionManager = /** @class */ (function () {
        // immediately hook into visibility changes. strange things can happen to timeouts while a device
        // is asleep, so we want to reset them.
        function SessionManager() {
            var _this = this;
            if (typeof document !== "undefined") {
                document.addEventListener("visibilitychange", function () {
                    if (document.visibilityState === "visible") {
                        _this.scheduleRefresh();
                    }
                });
            }
        }
        SessionManager.prototype.setStore = function (store) {
            this.store = store;
        };
        // read from the store
        SessionManager.prototype.sessionToken = function () {
            if (!this.store) {
                return undefined;
            }
            return this.store.read();
        };
        // write to the store
        SessionManager.prototype.update = function (id_token) {
            if (!this.store) {
                return;
            }
            this.store.update(id_token);
            var session = new JWTSession(id_token);
            this.refreshAt = Date.now() + session.halflife();
            this.scheduleRefresh();
        };
        // delete from the store
        SessionManager.prototype.endSession = function () {
            this.refreshAt = undefined;
            if (this.timeoutID) {
                clearTimeout(this.timeoutID);
            }
            if (this.store) {
                this.store.delete();
            }
        };
        // restoreSession runs an immediate token refresh and fulfills a promise if the session looks
        // alive. note that this is no guarantee, because of potentially bad client clocks.
        // TODO: change API to return a boolean and only reject in exceptional situations
        SessionManager.prototype.restoreSession = function () {
            var _this = this;
            return new Promise(function (fulfill, reject) {
                // configuration error
                if (!_this.store) {
                    reject("No session storage available.");
                    return;
                }
                // nothing to restore
                var token = _this.sessionToken();
                if (!token) {
                    reject("No session.");
                    return;
                }
                var now = Date.now(); // in ms
                var session = new JWTSession(token);
                var refreshAt = session.iat() + session.halflife();
                if (isNaN(refreshAt)) {
                    _this.store.delete();
                    reject("Malformed JWT: can not calculate refreshAt");
                    return;
                }
                // session looks to be aging or expired.
                //
                // NOTE: if the client's clock is quite wrong, we'll end up being pretty aggressive about
                // refreshing their session on pretty much every page load.
                if (now >= refreshAt || now < session.iat()) {
                    _this.refresh().then(fulfill, reject);
                    return;
                }
                // session looks good. keep an eye on it.
                _this.refreshAt = refreshAt;
                _this.scheduleRefresh();
                fulfill();
            });
        };
        SessionManager.prototype.refresh = function () {
            var _this = this;
            return refresh().then(function (id_token) { return _this.update(id_token); }, function (errors) {
                if (errors[0] && errors[0].message === "401") {
                    _this.endSession();
                }
                throw errors;
            });
        };
        SessionManager.prototype.scheduleRefresh = function () {
            var _this = this;
            if (this.timeoutID) {
                clearTimeout(this.timeoutID);
            }
            if (this.refreshAt) {
                this.timeoutID = setTimeout(function () {
                    return _this.refresh().catch(function (errors) {
                        // these errors have already been handled and are only propagating from `refresh` to
                        // keep its contract with restoreSession, which depends on rejecting to indicate there
                        // is no session.
                        if (errors[0] && errors[0].message === "401") {
                            return;
                        }
                        throw errors;
                    });
                }, this.refreshAt - Date.now());
            }
        };
        return SessionManager;
    }());

    var CookieSessionStore = /** @class */ (function () {
        function CookieSessionStore(cookieName, opts) {
            if (opts === void 0) { opts = {}; }
            this.sessionName = cookieName;
            this.path = !!opts.path ? "; path=" + opts.path : "";
            this.sameSite = !!opts.sameSite ? "; SameSite=" + opts.sameSite : "";
            if (typeof window !== "undefined") {
                this.secureFlag = window.location.protocol === "https:" ? "; secure" : "";
            }
        }
        CookieSessionStore.prototype.read = function () {
            if (typeof document !== "undefined") {
                return document.cookie.replace(new RegExp("(?:(?:^|.*;\\s*)" + this.sessionName + "\\s*\\=\\s*([^;]*).*$)|^.*$"), "$1");
            }
        };
        CookieSessionStore.prototype.update = function (val) {
            if (typeof document !== "undefined") {
                document.cookie = this.sessionName + "=" + val + this.secureFlag + this.path + this.sameSite;
            }
        };
        CookieSessionStore.prototype.delete = function () {
            if (typeof document !== "undefined") {
                document.cookie =
                    this.sessionName + "=; expires=Thu, 01 Jan 1970 00:00:01 GMT;";
            }
        };
        return CookieSessionStore;
    }());

    var MemorySessionStore = /** @class */ (function () {
        function MemorySessionStore() {
        }
        MemorySessionStore.prototype.read = function () {
            return this.session;
        };
        MemorySessionStore.prototype.update = function (val) {
            this.session = val;
        };
        MemorySessionStore.prototype.delete = function () {
            this.session = undefined;
        };
        return MemorySessionStore;
    }());

    function localStorageSupported() {
        var str = "keratin-authn-test";
        try {
            if (typeof window !== "undefined") {
                window.localStorage.setItem(str, str);
                window.localStorage.removeItem(str);
            }
            return true;
        }
        catch (e) {
            return false;
        }
    }
    var LocalStorageSessionStore = /** @class */ (function () {
        function LocalStorageSessionStore(name) {
            this.sessionName = name;
        }
        LocalStorageSessionStore.prototype.read = function () {
            if (typeof window !== "undefined") {
                return window.localStorage.getItem(this.sessionName) || undefined;
            }
        };
        LocalStorageSessionStore.prototype.update = function (val) {
            if (typeof window !== "undefined") {
                window.localStorage.setItem(this.sessionName, val);
            }
        };
        LocalStorageSessionStore.prototype.delete = function () {
            if (typeof window !== "undefined") {
                window.localStorage.removeItem(this.sessionName);
            }
        };
        return LocalStorageSessionStore;
    }());

    var manager = new SessionManager();
    function setStore(store) {
        manager.setStore(store);
    }
    function restoreSession() {
        return manager.restoreSession();
    }
    function importSession() {
        return manager.refresh();
    }
    function setCookieStore(sessionName, opts) {
        setStore(new CookieSessionStore(sessionName, opts));
    }
    function setLocalStorageStore(sessionName) {
        localStorageSupported()
            ? setStore(new LocalStorageSessionStore(sessionName))
            : setStore(new MemorySessionStore());
    }
    function session() {
        return manager.sessionToken();
    }
    function signup(credentials) {
        return signup$1(credentials).then(function (token) { return manager.update(token); });
    }
    function login(credentials) {
        return login$1(credentials).then(function (token) { return manager.update(token); });
    }
    function logout() {
        return logout$1().then(function () { return manager.endSession(); });
    }
    function changePassword(args) {
        return changePassword$1(args).then(function (token) { return manager.update(token); });
    }
    function resetPassword(args) {
        return resetPassword$1(args).then(function (token) { return manager.update(token); });
    }
    function sessionTokenLogin(args) {
        return sessionTokenLogin$1(args).then(function (token) { return manager.update(token); });
    }

    exports.changePassword = changePassword;
    exports.importSession = importSession;
    exports.isAvailable = isAvailable;
    exports.login = login;
    exports.logout = logout;
    exports.requestPasswordReset = requestPasswordReset;
    exports.requestSessionToken = requestSessionToken;
    exports.resetPassword = resetPassword;
    exports.restoreSession = restoreSession;
    exports.session = session;
    exports.sessionTokenLogin = sessionTokenLogin;
    exports.setCookieStore = setCookieStore;
    exports.setHost = setHost;
    exports.setLocalStorageStore = setLocalStorageStore;
    exports.signup = signup;

    Object.defineProperty(exports, '__esModule', { value: true });

})));
