(() => {
"use strict";

const vd = vendetta;

function makeDisplayManifest(manifest = {}) {
    return {
        ...manifest,
        version: manifest.version ?? manifest.hash ?? "0.0.0",
        display: {
            name: manifest.name ?? manifest.display?.name ?? "Unknown plugin",
            description: manifest.description ?? manifest.display?.description ?? "",
            authors: manifest.authors ?? manifest.display?.authors ?? []
        }
    };
}

function registeredPluginMap() {
    const records = vd.plugins?.plugins ?? {};
    return new Map(
        Object.entries(records).map(([id, entry]) => [
            id,
            makeDisplayManifest(entry?.manifest ?? {})
        ])
    );
}

function findThemeId(theme) {
    if (typeof theme === "string") return theme;
    const themes = vd.themes?.themes ?? {};
    for (const [id, candidate] of Object.entries(themes)) {
        if (candidate === theme) return id;
    }
    return "default";
}

const emptyInstances = new Map();

const bunny = {
    plugin: {
        createStorage() {
            return vd.plugin?.storage ?? {};
        }
    },
    api: {
        patcher: {
            before: (...args) => vd.patcher.before(...args),
            after: (...args) => vd.patcher.after(...args),
            instead: (...args) => vd.patcher.instead(...args)
        },
        commands: {
            registerCommand: (...args) => vd.commands?.registerCommand?.(...args)
        }
    },
    metro: {
        common: vd.metro?.common ?? {},
        filters: {
            byProps: (...props) => module => props.every(prop => prop in (module ?? {})),
            byDisplayName: name => module => module?.displayName === name
        },
        findExports: filter => vd.metro?.find?.(filter),
        findAllExports: filter => vd.metro?.findAll?.(filter) ?? [],
        findByProps: (...props) => vd.metro?.findByProps?.(...props),
        findByDisplayName: name => vd.metro?.findByDisplayName?.(name),
        findByStoreName: name => vd.metro?.findByStoreName?.(name)
    },
    ui: {
        components: vd.ui?.components ?? {},
        toasts: {
            showToast: (...args) => vd.ui?.toasts?.showToast?.(...args)
        }
    },
    plugins: {
        get registeredPlugins() {
            return registeredPluginMap();
        },
        pluginInstances: emptyInstances,
        isPluginEnabled(id) {
            return Boolean(vd.plugins?.plugins?.[id]?.enabled);
        },
        enablePlugin(id) {
            return vd.plugins?.startPlugin?.(id);
        },
        disablePlugin(id) {
            return vd.plugins?.stopPlugin?.(id);
        },
        async refreshPlugin(id) {
            const enabled = Boolean(vd.plugins?.plugins?.[id]?.enabled);
            if (enabled) vd.plugins?.stopPlugin?.(id, false);
            await vd.plugins?.fetchPlugin?.(id);
            if (enabled) return vd.plugins?.startPlugin?.(id);
        }
    },
    themes: {
        get themes() {
            return vd.themes?.themes ?? {};
        },
        selectTheme(theme) {
            return vd.themes?.selectTheme?.(findThemeId(theme));
        }
    }
};

const definePlugin = value => value;

/*
 * BD Mobile Compat
 *
 * Experimental BetterDiscord BdApi compatibility bridge for Revenge.
 * This does not copy or bundle Discord, BetterDiscord, or Revenge code.
 */
const BRIDGE_ID = "dev.bdmobile.compat";
const BRIDGE_VERSION = "0.1.0";
const storage = bunny.plugin.createStorage();
const previousBdApiDescriptor = Object.getOwnPropertyDescriptor(globalThis, "BdApi");
const previousMobileDescriptor = Object.getOwnPropertyDescriptor(globalThis, "BDMobileCompat");
const patchesByCaller = new Map();
const commandDisposersByCaller = new Map();
function ensureStorage() {
    storage.data ??= {};
    storage.safeMode ??= false;
    storage.strictUnsupported ??= false;
    storage.bootCount ??= 0;
    storage.lastBootOk ??= true;
    return storage;
}
function stringifyContent(content) {
    if (typeof content === "string")
        return content;
    if (content == null)
        return "";
    if (typeof content === "number" || typeof content === "boolean")
        return String(content);
    try {
        return JSON.stringify(content, null, 2);
    }
    catch {
        return String(content);
    }
}
function logPrefix(scope) {
    return scope ? `[BDMobile:${scope}]` : "[BDMobile]";
}
function unsupported(name, fallback) {
    const message = `${name} is not available on Discord Android/React Native.`;
    if (ensureStorage().strictUnsupported)
        throw new Error(message);
    console.warn(logPrefix("Compat"), message);
    return fallback;
}
function toDisplayAddon(id, manifest, instance) {
    const display = manifest?.display ?? {};
    const authors = Array.isArray(display.authors)
        ? display.authors.map((author) => author?.name).filter(Boolean)
        : [];
    return {
        id,
        name: display.name ?? id,
        author: authors.join(", "),
        authors: display.authors ?? [],
        version: manifest?.version ?? "0.0.0",
        description: display.description ?? "",
        filename: id,
        instance,
        manifest
    };
}
function resolvePluginId(idOrName) {
    const manifests = bunny.plugins?.registeredPlugins;
    if (!manifests)
        return undefined;
    if (manifests.has(idOrName))
        return idOrName;
    const lowered = String(idOrName).toLowerCase();
    for (const [id, manifest] of manifests) {
        if (String(manifest?.display?.name ?? "").toLowerCase() === lowered)
            return id;
    }
    return undefined;
}
function resolveThemeId(idOrName) {
    const themes = bunny.themes?.themes ?? {};
    if (themes[idOrName])
        return idOrName;
    const lowered = String(idOrName).toLowerCase();
    for (const [id, theme] of Object.entries(themes)) {
        const name = theme?.data?.name ?? theme?.data?.display?.name ?? id;
        if (String(name).toLowerCase() === lowered)
            return id;
    }
    return undefined;
}
function trackDisposer(map, caller, disposer) {
    let set = map.get(caller);
    if (!set)
        map.set(caller, set = new Set());
    set.add(disposer);
    let active = true;
    return () => {
        if (!active)
            return false;
        active = false;
        set?.delete(disposer);
        if (set?.size === 0)
            map.delete(caller);
        return disposer();
    };
}
function disposeCaller(map, caller) {
    const disposers = map.get(caller);
    if (!disposers)
        return;
    map.delete(caller);
    for (const disposer of [...disposers]) {
        try {
            disposer();
        }
        catch (error) {
            console.error(logPrefix(caller), "Disposer failed", error);
        }
    }
}
function disposeAll(map) {
    for (const caller of [...map.keys()])
        disposeCaller(map, caller);
}
class DataApi {
    save(pluginName, key, value) {
        const state = ensureStorage();
        state.data[pluginName] ??= {};
        state.data[pluginName][key] = value;
    }
    load(pluginName, key) {
        return ensureStorage().data[pluginName]?.[key];
    }
    delete(pluginName, key) {
        const pluginData = ensureStorage().data[pluginName];
        if (!pluginData || !(key in pluginData))
            return false;
        delete pluginData[key];
        if (Object.keys(pluginData).length === 0)
            delete ensureStorage().data[pluginName];
        return true;
    }
    async recache(_pluginName) {
        return true;
    }
}
class BoundDataApi {
    constructor(pluginName) {
        this.pluginName = pluginName;
    }
    save(key, value) { Data.save(this.pluginName, key, value); }
    load(key) { return Data.load(this.pluginName, key); }
    delete(key) { return Data.delete(this.pluginName, key); }
    recache() { return Data.recache(this.pluginName); }
}
const Data = new DataApi();
class LoggerApi {
    log(pluginName, ...message) { console.log(logPrefix(pluginName), ...message); }
    info(pluginName, ...message) { console.info(logPrefix(pluginName), ...message); }
    warn(pluginName, ...message) { console.warn(logPrefix(pluginName), ...message); }
    error(pluginName, ...message) { console.error(logPrefix(pluginName), ...message); }
    debug(pluginName, ...message) { console.debug(logPrefix(pluginName), ...message); }
    stacktrace(pluginName, message, error) {
        console.error(logPrefix(pluginName), message, error);
    }
}
class BoundLoggerApi {
    constructor(pluginName) {
        this.pluginName = pluginName;
    }
    log(...message) { Logger.log(this.pluginName, ...message); }
    info(...message) { Logger.info(this.pluginName, ...message); }
    warn(...message) { Logger.warn(this.pluginName, ...message); }
    error(...message) { Logger.error(this.pluginName, ...message); }
    debug(...message) { Logger.debug(this.pluginName, ...message); }
    stacktrace(message, error) { Logger.stacktrace(this.pluginName, message, error); }
}
const Logger = new LoggerApi();
class PatcherApi {
    before(caller, target, method, callback) {
        if (ensureStorage().safeMode)
            return unsupported("BdApi.Patcher.before (safe mode)", () => false);
        if (!target || typeof target[method] !== "function")
            throw new TypeError(`Cannot patch ${method}`);
        const unpatch = bunny.api.patcher.before(method, target, (args) => {
            try {
                const nextArgs = callback(target, args);
                return Array.isArray(nextArgs) ? nextArgs : undefined;
            }
            catch (error) {
                Logger.error(caller, `before patch for ${method} failed`, error);
                return undefined;
            }
        });
        return trackDisposer(patchesByCaller, caller, unpatch);
    }
    after(caller, target, method, callback) {
        if (ensureStorage().safeMode)
            return unsupported("BdApi.Patcher.after (safe mode)", () => false);
        if (!target || typeof target[method] !== "function")
            throw new TypeError(`Cannot patch ${method}`);
        const unpatch = bunny.api.patcher.after(method, target, (args, result) => {
            try {
                const replacement = callback(target, args, result);
                return replacement === undefined ? result : replacement;
            }
            catch (error) {
                Logger.error(caller, `after patch for ${method} failed`, error);
                return result;
            }
        });
        return trackDisposer(patchesByCaller, caller, unpatch);
    }
    instead(caller, target, method, callback) {
        if (ensureStorage().safeMode)
            return unsupported("BdApi.Patcher.instead (safe mode)", () => false);
        if (!target || typeof target[method] !== "function")
            throw new TypeError(`Cannot patch ${method}`);
        const unpatch = bunny.api.patcher.instead(method, target, (args, original) => {
            const callOriginal = (...nextArgs) => original(...(nextArgs.length ? nextArgs : args));
            try {
                return callback(target, args, callOriginal);
            }
            catch (error) {
                Logger.error(caller, `instead patch for ${method} failed`, error);
                return callOriginal(...args);
            }
        });
        return trackDisposer(patchesByCaller, caller, unpatch);
    }
    getPatchesByCaller(caller) {
        return [...(patchesByCaller.get(caller) ?? [])].map(unpatch => ({ unpatch }));
    }
    unpatchAll(caller) { disposeCaller(patchesByCaller, caller); }
}
class BoundPatcherApi {
    constructor(caller) {
        this.caller = caller;
    }
    before(target, method, callback) {
        return Patcher.before(this.caller, target, method, callback);
    }
    after(target, method, callback) {
        return Patcher.after(this.caller, target, method, callback);
    }
    instead(target, method, callback) {
        return Patcher.instead(this.caller, target, method, callback);
    }
    getPatchesByCaller() { return Patcher.getPatchesByCaller(this.caller); }
    unpatchAll() { Patcher.unpatchAll(this.caller); }
}
const Patcher = new PatcherApi();
const ReactModule = bunny.metro?.common?.React ?? globalThis.React;
const ReactNativeModule = bunny.metro?.common?.ReactNative ?? globalThis.ReactNative;
const UI = {
    showToast(content, _options = {}) {
        const message = stringifyContent(content);
        const showToast = bunny.ui?.toasts?.showToast;
        if (typeof showToast === "function")
            showToast(message);
        else
            console.info(logPrefix("Toast"), message);
    },
    alert(title, content) {
        const nativeAlert = ReactNativeModule?.Alert?.alert;
        if (typeof nativeAlert === "function")
            nativeAlert(stringifyContent(title), stringifyContent(content));
        else
            UI.showToast(`${stringifyContent(title)}: ${stringifyContent(content)}`);
    },
    showConfirmationModal(title, content, options = {}) {
        const nativeAlert = ReactNativeModule?.Alert?.alert;
        if (typeof nativeAlert !== "function") {
            unsupported("BdApi.UI.showConfirmationModal", undefined);
            return () => false;
        }
        nativeAlert(stringifyContent(title), stringifyContent(content), [
            {
                text: options.cancelText ?? "Cancel",
                style: "cancel",
                onPress: () => options.onCancel?.()
            },
            {
                text: options.confirmText ?? "Okay",
                style: options.danger ? "destructive" : "default",
                onPress: () => options.onConfirm?.()
            }
        ], {
            cancelable: true,
            onDismiss: () => options.onCancel?.()
        });
        return () => false;
    },
    showNotice(content, options = {}) {
        UI.showToast(content, options);
        return () => false;
    },
    showChangelogModal(options) {
        UI.alert(options?.title ?? "Changelog", options?.changes ?? options?.subtitle ?? "");
    }
};
const Plugins = {
    get folder() { return undefined; },
    getAll() {
        const manifests = bunny.plugins?.registeredPlugins;
        if (!manifests)
            return [];
        return [...manifests].map(([id, manifest]) => toDisplayAddon(id, manifest, bunny.plugins?.pluginInstances?.get?.(id)));
    },
    get(idOrName) {
        const id = resolvePluginId(idOrName);
        if (!id)
            return undefined;
        const manifest = bunny.plugins?.registeredPlugins?.get?.(id);
        return manifest ? toDisplayAddon(id, manifest, bunny.plugins?.pluginInstances?.get?.(id)) : undefined;
    },
    isEnabled(idOrName) {
        const id = resolvePluginId(idOrName);
        return Boolean(id && bunny.plugins?.isPluginEnabled?.(id));
    },
    enable(idOrName) {
        const id = resolvePluginId(idOrName);
        if (!id)
            return undefined;
        return bunny.plugins?.enablePlugin?.(id, true);
    },
    disable(idOrName) {
        const id = resolvePluginId(idOrName);
        if (!id)
            return undefined;
        return bunny.plugins?.disablePlugin?.(id);
    },
    toggle(idOrName) {
        return Plugins.isEnabled(idOrName) ? Plugins.disable(idOrName) : Plugins.enable(idOrName);
    },
    async reload(idOrName) {
        const id = resolvePluginId(idOrName);
        if (!id)
            return undefined;
        if (typeof bunny.plugins?.refreshPlugin === "function" && bunny.plugins?.pluginInstances?.has?.(id)) {
            return bunny.plugins.refreshPlugin(id);
        }
        if (Plugins.isEnabled(id)) {
            Plugins.disable(id);
            return Plugins.enable(id);
        }
        return undefined;
    }
};
const Themes = {
    get folder() { return undefined; },
    getAll() {
        const themes = bunny.themes?.themes ?? {};
        return Object.entries(themes).map(([id, theme]) => ({
            id,
            name: theme?.data?.name ?? id,
            version: theme?.data?.version ?? "0.0.0",
            description: theme?.data?.description ?? "",
            author: theme?.data?.author ?? "",
            filename: id,
            enabled: Boolean(theme?.selected),
            instance: theme
        }));
    },
    get(idOrName) {
        const id = resolveThemeId(idOrName);
        return id ? Themes.getAll().find(theme => theme.id === id) : undefined;
    },
    isEnabled(idOrName) {
        const id = resolveThemeId(idOrName);
        return Boolean(id && bunny.themes?.themes?.[id]?.selected);
    },
    enable(idOrName) {
        const id = resolveThemeId(idOrName);
        const theme = id ? bunny.themes?.themes?.[id] : undefined;
        return theme ? bunny.themes?.selectTheme?.(theme) : undefined;
    },
    disable(idOrName) {
        return Themes.isEnabled(idOrName) ? bunny.themes?.selectTheme?.(null) : undefined;
    },
    toggle(idOrName) {
        return Themes.isEnabled(idOrName) ? Themes.disable(idOrName) : Themes.enable(idOrName);
    },
    reload(idOrName) {
        const id = resolveThemeId(idOrName);
        const theme = id ? bunny.themes?.themes?.[id] : undefined;
        return theme && theme.selected ? bunny.themes?.selectTheme?.(theme) : undefined;
    }
};
function metroFilter(filter) {
    const wrapped = (moduleExports, moduleId, defaultExport) => {
        try {
            return Boolean(filter(moduleExports, moduleId, defaultExport));
        }
        catch {
            return false;
        }
    };
    wrapped.uniq = false;
    wrapped.raw = false;
    return wrapped;
}
const WebpackFilters = {
    byKeys: (...keys) => bunny.metro?.filters?.byProps?.(...keys) ?? metroFilter((module) => keys.every(key => key in (module ?? {}))),
    byPrototypeKeys: (...keys) => metroFilter((module) => keys.every(key => key in (module?.prototype ?? {}))),
    byDisplayName: (name) => bunny.metro?.filters?.byDisplayName?.(name) ?? metroFilter((module) => module?.displayName === name),
    byStrings: (...strings) => metroFilter((module) => {
        const source = typeof module === "function" ? Function.prototype.toString.call(module) : "";
        return strings.every(value => source.includes(value));
    }),
    byRegex: (regex) => metroFilter((module) => typeof module === "function" && regex.test(Function.prototype.toString.call(module))),
    combine: (...filters) => metroFilter((module, id, defaultExport) => filters.every(filter => filter(module, id, defaultExport)))
};
const Webpack = {
    Filters: WebpackFilters,
    getModule(filter, _options = {}) {
        if (ensureStorage().safeMode)
            return unsupported("BdApi.Webpack.getModule (safe mode)", undefined);
        try {
            return bunny.metro?.findExports?.(metroFilter(filter));
        }
        catch (error) {
            Logger.error("Webpack", "getModule failed", error);
            return undefined;
        }
    },
    getModules(filter) {
        if (ensureStorage().safeMode)
            return unsupported("BdApi.Webpack.getModules (safe mode)", []);
        try {
            return bunny.metro?.findAllExports?.(metroFilter(filter))?.filter(Boolean) ?? [];
        }
        catch (error) {
            Logger.error("Webpack", "getModules failed", error);
            return [];
        }
    },
    getByKeys(...keys) {
        if (ensureStorage().safeMode)
            return unsupported("BdApi.Webpack.getByKeys (safe mode)", undefined);
        return bunny.metro?.findByProps?.(...keys) ?? Webpack.getModule((module) => keys.every(key => key in (module ?? {})));
    },
    getByPrototypeKeys(...keys) {
        return Webpack.getModule((module) => keys.every(key => key in (module?.prototype ?? {})));
    },
    getByDisplayName(name) {
        if (ensureStorage().safeMode)
            return unsupported("BdApi.Webpack.getByDisplayName (safe mode)", undefined);
        return bunny.metro?.findByDisplayName?.(name) ?? Webpack.getModule((module) => module?.displayName === name);
    },
    getByStrings(...strings) {
        return Webpack.getModule(WebpackFilters.byStrings(...strings));
    },
    getStore(name) {
        if (ensureStorage().safeMode)
            return unsupported("BdApi.Webpack.getStore (safe mode)", undefined);
        return bunny.metro?.findByStoreName?.(name);
    },
    async waitForModule(filter, options = {}) {
        const timeout = Number(options.timeout ?? 10_000);
        const interval = Number(options.interval ?? 100);
        const started = Date.now();
        while (Date.now() - started < timeout) {
            const found = Webpack.getModule(filter, options);
            if (found !== undefined)
                return found;
            await new Promise(resolve => setTimeout(resolve, interval));
        }
        return undefined;
    }
};
const Utils = {
    findInTree(tree, filter, options = {}) {
        const walkable = options.walkable;
        const ignore = new Set(options.ignore ?? []);
        const seen = new Set();
        const visit = (value) => {
            if (value == null || (typeof value !== "object" && typeof value !== "function"))
                return undefined;
            if (seen.has(value))
                return undefined;
            seen.add(value);
            if (filter(value))
                return value;
            const keys = walkable ?? Object.keys(value);
            for (const key of keys) {
                if (ignore.has(key))
                    continue;
                let child;
                try {
                    child = value[key];
                }
                catch {
                    continue;
                }
                const found = visit(child);
                if (found !== undefined)
                    return found;
            }
            return undefined;
        };
        return visit(tree);
    },
    findInReactTree(tree, filter) {
        return Utils.findInTree(tree, filter, { walkable: ["props", "children", "child", "sibling"] });
    },
    getNestedValue(object, path) {
        const parts = Array.isArray(path) ? path : String(path).split(".");
        return parts.reduce((value, key) => value?.[key], object);
    },
    debounce(callback, delay) {
        let timer;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => callback.apply(this, args), delay);
        };
    },
    throttle(callback, delay) {
        let last = 0;
        let pending;
        return function (...args) {
            const now = Date.now();
            const remaining = delay - (now - last);
            if (remaining <= 0) {
                clearTimeout(pending);
                last = now;
                return callback.apply(this, args);
            }
            clearTimeout(pending);
            pending = setTimeout(() => {
                last = Date.now();
                callback.apply(this, args);
            }, remaining);
        };
    },
    className(...values) {
        return values.filter(Boolean).join(" ");
    },
    escapeHTML(value) {
        return stringifyContent(value)
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#039;");
    }
};
const DOM = {
    addStyle(_id, _css) { unsupported("BdApi.DOM.addStyle"); },
    removeStyle(_id) { unsupported("BdApi.DOM.removeStyle"); },
    createElement() { return unsupported("BdApi.DOM.createElement", undefined); },
    parseHTML() { return unsupported("BdApi.DOM.parseHTML", undefined); }
};
const ReactUtils = {
    findInTree: Utils.findInTree,
    findInReactTree: Utils.findInReactTree,
    getInternalInstance() { return unsupported("BdApi.ReactUtils.getInternalInstance", undefined); },
    getOwnerInstance() { return unsupported("BdApi.ReactUtils.getOwnerInstance", undefined); }
};
const ContextMenu = {
    patch() { return unsupported("BdApi.ContextMenu.patch", () => false); },
    unpatch() { unsupported("BdApi.ContextMenu.unpatch"); },
    open() { unsupported("BdApi.ContextMenu.open"); },
    close() { unsupported("BdApi.ContextMenu.close"); }
};
const Net = {
    fetch(input, init) {
        return globalThis.fetch(input, init);
    }
};
class CommandsApi {
    register(caller, command) {
        const register = bunny.api?.commands?.registerCommand;
        if (typeof register !== "function")
            return unsupported("BdApi.Commands.register", () => false);
        const disposer = register(command);
        return trackDisposer(commandDisposersByCaller, caller, disposer);
    }
    unregisterAll(caller) { disposeCaller(commandDisposersByCaller, caller); }
}
class BoundCommandsApi {
    constructor(caller) {
        this.caller = caller;
    }
    register(command) { return Commands.register(this.caller, command); }
    unregisterAll() { Commands.unregisterAll(this.caller); }
}
const Commands = new CommandsApi();
const scopedApis = new Map();
class BdApiCompat {
    constructor(pluginName) {
        const resolvedName = typeof pluginName === "string" && pluginName.length > 0
            ? pluginName
            : "UnknownPlugin";
        const cached = scopedApis.get(resolvedName);
        if (cached)
            return cached;
        this.pluginName = resolvedName;
        scopedApis.set(resolvedName, this);
    }
    get version() { return BdApiCompat.version; }
    get React() { return BdApiCompat.React; }
    get ReactDOM() { return undefined; }
    get ReactNative() { return ReactNativeModule; }
    get Components() { return BdApiCompat.Components; }
    get Net() { return Net; }
    get Webpack() { return Webpack; }
    get Plugins() { return Plugins; }
    get Themes() { return Themes; }
    get Utils() { return Utils; }
    get UI() { return UI; }
    get ReactUtils() { return ReactUtils; }
    get ContextMenu() { return ContextMenu; }
    get DOM() { return DOM; }
    get Hooks() { return {}; }
    get Patcher() { return new BoundPatcherApi(this.pluginName); }
    get Data() { return new BoundDataApi(this.pluginName); }
    get Logger() { return new BoundLoggerApi(this.pluginName); }
    get Commands() { return new BoundCommandsApi(this.pluginName); }
}
BdApiCompat.version = `${BRIDGE_VERSION}-android`;
BdApiCompat.React = ReactModule;
BdApiCompat.ReactDOM = undefined;
BdApiCompat.Components = bunny.ui?.components ?? {};
BdApiCompat.Net = Net;
BdApiCompat.Webpack = Webpack;
BdApiCompat.Plugins = Plugins;
BdApiCompat.Themes = Themes;
BdApiCompat.Utils = Utils;
BdApiCompat.UI = UI;
BdApiCompat.ReactUtils = ReactUtils;
BdApiCompat.ContextMenu = ContextMenu;
BdApiCompat.Patcher = Patcher;
BdApiCompat.Data = Data;
BdApiCompat.DOM = DOM;
BdApiCompat.Logger = Logger;
BdApiCompat.Commands = Commands;
BdApiCompat.Hooks = {};
BdApiCompat.ReactNative = ReactNativeModule;
BdApiCompat.mobile = true;
function installGlobals() {
    Object.defineProperty(globalThis, "BdApi", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: BdApiCompat
    });
    Object.defineProperty(globalThis, "BDMobileCompat", {
        configurable: true,
        enumerable: false,
        writable: false,
        value: {
            id: BRIDGE_ID,
            version: BRIDGE_VERSION,
            platform: "android",
            runtime: "revenge",
            get safeMode() { return ensureStorage().safeMode; },
            get strictUnsupported() { return ensureStorage().strictUnsupported; },
            compatibility: {
                Data: "supported",
                Logger: "supported",
                UI: "partial",
                Patcher: "adapted",
                Plugins: "adapted",
                Themes: "native-theme-only",
                Webpack: "best-effort-metro",
                DOM: "unsupported",
                ReactDOM: "unsupported",
                Electron: "unsupported",
                CSS: "unsupported"
            }
        }
    });
}
function restoreDescriptor(name, descriptor) {
    try {
        if (descriptor)
            Object.defineProperty(globalThis, name, descriptor);
        else
            delete globalThis[name];
    }
    catch (error) {
        console.error(logPrefix("Compat"), `Unable to restore ${name}`, error);
    }
}
function SettingsComponent() {
    if (!ReactModule?.createElement || !ReactNativeModule)
        return null;
    const React = ReactModule;
    const RN = ReactNativeModule;
    const state = ensureStorage();
    const [, refresh] = React.useReducer((value) => value + 1, 0);
    const setFlag = (key, value) => {
        state[key] = value;
        refresh();
        UI.showToast("Setting saved. Restart Discord to fully apply it.");
    };
    const row = (label, value) => React.createElement(RN.View, { style: styles.row, key: label }, React.createElement(RN.Text, { style: styles.label }, label), React.createElement(RN.Text, { style: styles.value }, value));
    return React.createElement(RN.ScrollView, { style: styles.container, contentContainerStyle: styles.content }, React.createElement(RN.Text, { style: styles.title }, "BD Mobile Compat"), React.createElement(RN.Text, { style: styles.description }, "Experimental BdApi bridge for BetterDiscord-style plugins on Revenge. Desktop CSS, DOM and Electron APIs cannot run on mobile."), React.createElement(RN.View, { style: styles.switchRow }, React.createElement(RN.View, { style: styles.switchText }, React.createElement(RN.Text, { style: styles.label }, "Safe mode"), React.createElement(RN.Text, { style: styles.help }, "Disables Patcher and Metro/Webpack compatibility.")), React.createElement(RN.Switch, {
        value: state.safeMode,
        onValueChange: (value) => setFlag("safeMode", value)
    })), React.createElement(RN.View, { style: styles.switchRow }, React.createElement(RN.View, { style: styles.switchText }, React.createElement(RN.Text, { style: styles.label }, "Strict unsupported APIs"), React.createElement(RN.Text, { style: styles.help }, "Throws an error instead of returning a safe fallback.")), React.createElement(RN.Switch, {
        value: state.strictUnsupported,
        onValueChange: (value) => setFlag("strictUnsupported", value)
    })), React.createElement(RN.Text, { style: styles.section }, "Compatibility"), row("Data / Logger", "Supported"), row("UI", "Partial, native dialogs"), row("Patcher", "Adapted to Revenge"), row("Plugins", "Revenge plugins"), row("Themes", "Native JSON themes"), row("Webpack", "Best effort via Metro"), row("DOM / CSS / Electron", "Unsupported"), React.createElement(RN.Pressable, {
        style: styles.button,
        onPress: () => UI.showToast(`BdApi ${BdApiCompat.version} is active`)
    }, React.createElement(RN.Text, { style: styles.buttonText }, "Run diagnostic toast")), React.createElement(RN.Pressable, {
        style: [styles.button, styles.dangerButton],
        onPress: () => UI.showConfirmationModal("Reset compatibility data?", "This clears values saved through BdApi.Data. BetterDiscord plugins may lose their settings.", {
            danger: true,
            confirmText: "Reset",
            onConfirm: () => {
                state.data = {};
                refresh();
                UI.showToast("Compatibility data cleared");
            }
        })
    }, React.createElement(RN.Text, { style: styles.buttonText }, "Reset BdApi.Data")));
}
const styles = ReactNativeModule?.StyleSheet?.create?.({
    container: { flex: 1 },
    content: { padding: 16, gap: 12 },
    title: { fontSize: 24, fontWeight: "700", color: "white" },
    description: { fontSize: 14, lineHeight: 20, opacity: 0.8, color: "white" },
    section: { marginTop: 12, fontSize: 17, fontWeight: "700", color: "white" },
    row: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 7 },
    switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 8 },
    switchText: { flex: 1, paddingRight: 12 },
    label: { fontSize: 15, fontWeight: "600", color: "white" },
    value: { fontSize: 13, opacity: 0.7, color: "white", textAlign: "right", maxWidth: "55%" },
    help: { fontSize: 12, opacity: 0.65, color: "white", marginTop: 3 },
    button: { padding: 13, borderRadius: 8, backgroundColor: "#5865F2", alignItems: "center", marginTop: 8 },
    dangerButton: { backgroundColor: "#DA373C" },
    buttonText: { color: "white", fontWeight: "700" }
}) ?? {};
const define = typeof definePlugin === "function" ? definePlugin : (value) => value;
const plugin = define({
    start() {
        const state = ensureStorage();
        state.bootCount += 1;
        state.lastBootOk = false;
        installGlobals();
        state.lastBootOk = true;
        UI.showToast(`BD Mobile Compat ${BRIDGE_VERSION} loaded${state.safeMode ? " in safe mode" : ""}`);
    },
    stop() {
        disposeAll(patchesByCaller);
        disposeAll(commandDisposersByCaller);
        scopedApis.clear();
        restoreDescriptor("BdApi", previousBdApiDescriptor);
        restoreDescriptor("BDMobileCompat", previousMobileDescriptor);
    },
    SettingsComponent
});


return {
    onLoad() {
        return plugin.start();
    },
    onUnload() {
        return plugin.stop();
    },
    settings: plugin.SettingsComponent
};
})()
