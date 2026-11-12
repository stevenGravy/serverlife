'use strict';
/**
 * Preload bridge. The renderer gets a typed, explicit API surface and nothing
 * else — no Node, no ipcRenderer, no arbitrary channel access.
 */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

/** Unwrap the {ok,data|error} envelope, throwing on failure. */
async function call(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (!res) throw new Error('No response from ' + channel);
  if (!res.ok) throw new Error(res.error || 'Unknown error');
  return res.data;
}

/** Fire-and-forget, for the one channel that answers a request from main. */
function send(channel, ...args) { ipcRenderer.send(channel, ...args); }

/** Register a push-event listener and hand back an unsubscribe function. */
function on(channel, handler) {
  const wrapped = (_e, ...args) => handler(...args);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld('api', {
  app: {
    info: () => call('app:info'),
    tools: () => call('tools:status'),
    onMenu: (h) => on('menu', h),
    onResume: (h) => on('app:resume', h),
    // Automation requests from the control socket, answered by the renderer.
    onAutomation: (h) => on('automation', h),
    automationResult: (payload) => send('automation:result', payload),
  },

  control: {
    status: () => call('control:status'),
    setEnabled: (on) => call('control:setEnabled', on),
    rotateToken: () => call('control:rotateToken'),
    onActivity: (h) => on('control:activity', h),
  },

  settings: {
    get: () => call('settings:get'),
    set: (patch) => call('settings:set', patch),
  },

  profiles: {
    list: () => call('profiles:list'),
    save: (p) => call('profiles:save', p),
    remove: (id) => call('profiles:delete', id),
    markUsed: (id) => call('profiles:markUsed', id),
    saveFolder: (f) => call('folders:save', f),
    listSnippets: () => call('snippets:list'),
    saveSnippet: (sn) => call('snippets:save', sn),
    deleteSnippet: (id) => call('snippets:delete', id),
    markSnippetUsed: (id) => call('snippets:used', id),
    removeFolder: (id) => call('folders:delete', id),
  },

  macros: {
    list: () => call('macros:list'),
    pin: (id, opts) => call('macros:pin', id, opts),
    save: (m) => call('macros:save', m),
    remove: (id) => call('macros:delete', id),
    setHidden: (id, hidden) => call('macros:hide', id, hidden),
    markUsed: (id) => call('macros:used', id),
    setCategoryOrder: (order) => call('macros:order', order),
    setOrder: (ids) => call('macros:arrange', ids),
  },

  window: {
    create: (opts) => call('window:new', opts),
    me: () => call('window:me'),
    adopted: () => call('window:adopted'),
    onAdoptPane: (h) => on('pane:adopt', h),
    list: () => call('window:list'),
  },

  rsync: {
    check: () => call('rsync:check'),
    transport: (connId) => call('rsync:transport', connId),
    run: (id, args) => call('rsync:run', id, args),
    cancel: (id) => call('rsync:cancel', id),
    onOut: (h) => on('rsync:out', h),
    onDone: (h) => on('rsync:done', h),
  },
  s3: {
    list: () => call('s3:list'),
    save: (t) => call('s3:save', t),
    remove: (id) => call('s3:delete', id),
    storageClasses: () => call('s3:storageClasses'),
    test: (t) => call('s3:test', t),
    browse: (id, prefix) => call('s3:browse', id, prefix),
    head: (id, key) => call('s3:head', id, key),
    prefixInfo: (id, prefix) => call('s3:prefixInfo', id, prefix),
    deleteKeys: (id, keys) => call('s3:remove', id, keys),
    copy: (id, fromKey, toKey, storageClass) => call('s3:copy', id, fromKey, toKey, storageClass),
    upload: (id, localPaths, prefix, opts) => call('s3:upload', id, localPaths, prefix, opts),
    download: (id, keys, destDir) => call('s3:download', id, keys, destDir),
    buckets: (t) => call('s3:buckets', t),
    bucketRegion: (t) => call('s3:bucketRegion', t),
    relayDir: () => call('s3:relayDir'),
    cleanRelay: (dir) => call('s3:cleanRelay', dir),
    fromServer: (connId, entries, s3Id, prefix, opts) => call('s3:fromServer', connId, entries, s3Id, prefix, opts),
    toServer: (s3Id, keys, connId, destDir) => call('s3:toServer', s3Id, keys, connId, destDir),
    bucketToBucket: (fromId, keys, toId, prefix, opts) => call('s3:bucketToBucket', fromId, keys, toId, prefix, opts),
  },

  sshopts: {
    get: (host) => call('sshopts:get', host),
    check: (options) => call('sshopts:check', options),
    command: (host, options, login) => call('sshopts:command', host, options, login),
    save: (host, opts) => call('sshopts:save', host, opts),
  },
  ai: {
    clients: (opts) => call('ai:clients', opts),
    launch: (id, opts) => call('ai:launch', id, opts),
    registerCommand: (id) => call('ai:registerCommand', id),
    register: (id) => call('ai:register', id),
    check: (id) => call('ai:check', id),
    preview: (id, draft) => call('ai:preview', id, draft),
    saveResponse: (r) => call('ai:saveResponse', r),
    savedList: () => call('ai:savedList'),
    savedRead: (file) => call('ai:savedRead', file),
    savedDelete: (file) => call('ai:savedDelete', file),
    savedReveal: (file) => call('ai:savedReveal', file),
  },
  vnet: {
    start: (opts) => call('vnet:start', opts),
    stop: (proxy) => call('vnet:stop', proxy),
    status: () => call('vnet:status'),
    onState: (h) => on('vnet:state', h),
  },
  aws: {
    profiles: () => call('aws:profiles'),
    profileCheck: (p) => call('aws:profileCheck', p),
    forgetProfile: (p) => call('aws:forgetProfile', p),
    apps: (opts) => call('aws:apps', opts),
    roles: (app, opts) => call('aws:roles', app, opts),
    login: (app, role, opts) => call('aws:login', app, role, opts),
    logout: (app, opts) => call('aws:logout', app, opts),
    proxies: () => call('aws:proxies'),
  },

  backup: {
    export: (what, ids) => call('backup:export', what, ids),
    read: () => call('backup:read'),
    apply: (doc, opts) => call('backup:apply', doc, opts),
  },

  /**
   * Beams: ephemeral sandbox VMs. `supported` is the capability probe, the
   * rest is the `tsh beams` command set. Opening one is `conn.create` with a
   * beam host, so terminals and files are the ordinary machinery.
   */
  beams: {
    supported: (opts) => call('beams:supported', opts),
    list: (opts) => call('beams:list', opts),
    add: (opts) => call('beams:add', opts),
    addSupport: (opts) => call('beams:addSupport', opts),
    phases: (opts) => call('beams:phases', opts),
    removePhase: (opts) => call('beams:removePhase', opts),
    phaseAddArgs: (opts) => call('beams:phaseAddArgs', opts),
    failedPhases: (opts) => call('beams:failedPhases', opts),
    phaseEditArgs: (opts) => call('beams:phaseEditArgs', opts),
    phaseApplyArgs: (opts) => call('beams:phaseApplyArgs', opts),
    phaseSnapshot: (opts) => call('beams:phaseSnapshot', opts),
    services: (opts) => call('beams:services', opts),
    serviceLogs: (opts) => call('beams:serviceLogs', opts),
    setupCatalog: () => call('phasesetup:catalog'),
    buildSetup: (stages) => call('phasesetup:build', stages),
    writeSetup: (opts) => call('phasesetup:write', opts),
    checkSetupYaml: (text) => call('phasesetup:checkYaml', text),
    openSetupYaml: () => call('phasesetup:open'),
    addins: () => call('phasesetup:addins'),
    checkAddin: (opts) => call('phasesetup:checkAddin', opts),
    saveAddin: (opts) => call('phasesetup:saveAddin', opts),
    removeAddin: (file) => call('phasesetup:removeAddin', file),
    openAddinsDir: () => call('phasesetup:openAddinsDir'),
    chooseAddinsDir: (opts) => call('phasesetup:chooseAddinsDir', opts),
    remove: (opts) => call('beams:remove', opts),
    stillListed: (opts) => call('beams:stillListed', opts),
    exec: (opts) => call('beams:exec', opts),
    publish: (opts) => call('beams:publish', opts),
    unpublish: (opts) => call('beams:unpublish', opts),
    scp: (opts) => call('beams:scp', opts),
  },

  kube: {
    cloudInfo: (opts) => call('kube:cloudInfo', opts),
    detectProvider: (opts) => call('kube:detectProvider', opts),
    heartbeat: (opts) => call('kube:heartbeat', opts),
    heartbeatTeleport: (opts) => call('kube:heartbeatTeleport', opts),
    openCloudConsole: (opts) => call('kube:openCloudConsole', opts),
    // Contexts from the default kubeconfig location plus any extra files
    // added in Settings. { extraPaths: [...] } -> { ok, contexts, paths }.
    contexts: (opts) => call('kube:contexts', opts),
    // The in-app kubeconfig editor: which files, read, have kubectl parse it, save.
    kubeconfigFiles: () => call('kubeconfig:files'),
    readKubeconfig: (file) => call('kubeconfig:read', file),
    checkKubeconfig: (opts) => call('kubeconfig:check', opts),
    writeKubeconfig: (opts) => call('kubeconfig:write', opts),
    clusters: (opts) => call('kube:clusters', opts),
    login: (opts) => call('kube:login', opts),
    useContext: (opts) => call('kube:useContext', opts),
    deleteContext: (opts) => call('kube:deleteContext', opts),
    editContext: (opts) => call('kube:editContext', opts),
    installTeleportAgent: (opts) => call('kube:installTeleportAgent', opts),
    teleportAgentValues: (opts) => call('kube:teleportAgentValues', opts),
    // tsh proxy kube — a local proxy for handing a cluster to a plain
    // kubectl or an external tool. See kubeproxy.js.
    proxyStart: (opts) => call('kube:proxyStart', opts),
    proxyStop: (opts) => call('kube:proxyStop', opts),
    proxyStatus: (opts) => call('kube:proxyStatus', opts),
    // `kubectl port-forward` to one pod/service/workload — see kubeforward.js.
    forwardStart: (opts) => call('kube:forwardStart', opts),
    forwardStop: (opts) => call('kube:forwardStop', opts),
    forwardList: () => call('kube:forwardList'),
    onForwardUpdate: (h) => on('kube:forwardUpdate', h),
    namespaces: (opts) => call('kube:namespaces', opts),
    pods: (opts) => call('kube:pods', opts),
    // { command, args, env } for localTerm.open() — a kube exec session is
    // opened as a local-shell pane running kubectl, not a Connection.
    execSpec: (opts) => call('kube:execSpec', opts),
    // Same shape, for attaching to an already-running container instead of
    // starting a new shell in it, and for an ephemeral debug container.
    attachSpec: (opts) => call('kube:attachSpec', opts),
    debugSpec: (opts) => call('kube:debugSpec', opts),
    // A privileged debug pod on a node — the one node has no exec of its own.
    nodeDebugSpec: (opts) => call('kube:nodeDebugSpec', opts),
    logSpec: (opts) => call('kube:logSpec', opts),
    kubeconfigEnv: (opts) => call('kube:kubeconfigEnv', opts),
    // The Log Viewer: lines pushed as they arrive, not a PTY. See kubelogs.js.
    logsStart: (opts) => call('kube:logsStart', opts),
    logsStop: (opts) => call('kube:logsStop', opts),
    onLogsData: (h) => on('kube:logsData', h),
    // Live rows for a list view: each watched object pushed as it
    // arrives, not polled for — see kubewatch.js.
    watchStart: (opts) => call('kube:watchStart', opts),
    watchStop: (opts) => call('kube:watchStop', opts),
    onWatchData: (h) => on('kube:watchData', h),
    // The pod's filesystem, through kubectl exec/cp — see kubefs.js.
    ls: (opts) => call('kube:ls', opts),
    mkdir: (opts) => call('kube:mkdir', opts),
    rm: (opts) => call('kube:rm', opts),
    rename: (opts) => call('kube:rename', opts),
    readFile: (opts) => call('kube:readFile', opts),
    writeFile: (opts) => call('kube:writeFile', opts),
    downloadPath: (opts) => call('kube:downloadPath', opts),
    uploadPath: (opts) => call('kube:uploadPath', opts),
    // The full-cluster browser — see kuberesources.js.
    resourceTypes: (opts) => call('kube:resourceTypes', opts),
    resources: (opts) => call('kube:resources', opts),
    resourceYaml: (opts) => call('kube:resourceYaml', opts),
    diffYaml: (opts) => call('kube:diffYaml', opts),
    applyYaml: (opts) => call('kube:applyYaml', opts),
    validateYaml: (opts) => call('kube:validateYaml', opts),
    explainFields: (opts) => call('kube:explainFields', opts),
    kustomizeBuild: (opts) => call('kube:kustomizeBuild', opts),
    describeResource: (opts) => call('kube:describeResource', opts),
    // The detail panel: the full object, and where it leads next.
    getObject: (opts) => call('kube:getObject', opts),
    crdColumns: (opts) => call('kube:crdColumns', opts),
    deleteResource: (opts) => call('kube:deleteResource', opts),
    cordonNode: (opts) => call('kube:cordonNode', opts),
    drainNode: (opts) => call('kube:drainNode', opts),
    canI: (opts) => call('kube:canI', opts),
    access: (opts) => call('kube:access', opts),
    whoCan: (opts) => call('kube:whoCan', opts),
    patchSecretData: (opts) => call('kube:patchSecretData', opts),
    lintScan: (opts) => call('kube:lintScan', opts),
    testServiceAccountAccess: (opts) => call('kube:testServiceAccountAccess', opts),
    top: (opts) => call('kube:top', opts),
    topPodContainers: (opts) => call('kube:topPodContainers', opts),
    // CPU/memory history: each poll pushed as it arrives — see kubemetrics.js.
    metricsStart: (opts) => call('kube:metricsStart', opts),
    metricsStop: (opts) => call('kube:metricsStop', opts),
    onMetricsData: (h) => on('kube:metricsData', h),
    // Workload actions — scale, rollout, set image/env/resources, CronJob
    // trigger/suspend, delete/evict (one or several), and the "create" forms'
    // manifest generation. See kubeops.js.
    scale: (opts) => call('kube:scale', opts),
    rollout: (opts) => call('kube:rollout', opts),
    rolloutHistory: (opts) => call('kube:rolloutHistory', opts),
    setImage: (opts) => call('kube:setImage', opts),
    setEnv: (opts) => call('kube:setEnv', opts),
    setResources: (opts) => call('kube:setResources', opts),
    containersOf: (opts) => call('kube:containersOf', opts),
    cronTrigger: (opts) => call('kube:cronTrigger', opts),
    cronSuspend: (opts) => call('kube:cronSuspend', opts),
    deleteMany: (opts) => call('kube:deleteMany', opts),
    evict: (opts) => call('kube:evict', opts),
    exportResources: (opts) => call('kube:exportResources', opts),
    groupBinding: (opts) => call('kube:groupBinding', opts),
    teleportRoleFor: (opts) => call('kube:teleportRoleFor', opts),
    manifestFor: (opts) => call('kube:manifestFor', opts),
    // Local ecosystem tools — see kubebin.js.
    ecosystemStatus: () => call('kube:ecosystemStatus'),
    scene: (opts) => call('kube:scene', opts),
    // Helm release management, surfaced in the full cluster browser — see kubehelm.js.
    helmReleases: (opts) => call('kube:helmReleases', opts),
    helmHistory: (opts) => call('kube:helmHistory', opts),
    helmValues: (opts) => call('kube:helmValues', opts),
    helmManifest: (opts) => call('kube:helmManifest', opts),
    helmGraph: (opts) => call('kube:helmGraph', opts),
    helmUpgrade: (opts) => call('kube:helmUpgrade', opts),
    helmSearch: (opts) => call('kube:helmSearch', opts),
    helmReadme: (opts) => call('kube:helmReadme', opts),
    helmValuesSchema: (opts) => call('kube:helmValuesSchema', opts),
    helmTest: (opts) => call('kube:helmTest', opts),
    helmRenderTemplate: (opts) => call('kube:helmRenderTemplate', opts),
    mermaid: (opts) => call('kube:mermaid', opts),
    helmRollback: (opts) => call('kube:helmRollback', opts),
    helmUninstall: (opts) => call('kube:helmUninstall', opts),
    helmAddRepo: (opts) => call('kube:helmAddRepo', opts),
    helmInstall: (opts) => call('kube:helmInstall', opts),
  },

  ssh: {
    // Why a login was refused, read out of `ssh -vv`.
    authProbe: (target, opts) => call('ssh:authProbe', target, opts),
  },

  discovery: {
    sshHosts: () => call('discovery:ssh'),
    sshConfigFiles: () => call('sshconfig:files'),
    pickSshConfigFile: () => call('sshconfig:pickFile'),
    tshConfigPreview: (opts) => call('sshconfig:tshPreview', opts),
    tshConfigWrite: (opts) => call('sshconfig:tshWrite', opts),
    addSshHost: (host) => call('sshconfig:add', host),
    removeSshHost: (alias) => call('sshconfig:remove', alias),
    managedSshHosts: () => call('sshconfig:managed'),
    sshConfigPath: () => call('sshconfig:path'),
    sshHostBlock: (opts) => call('sshconfig:blockPreview', opts),
    removeSshHostFromFile: (opts) => call('sshconfig:removeFromFile', opts),
    openSshConfigInEditor: (file) => call('sshconfig:openInEditor', file),
    // The in-app editor: read, have ssh parse it, save (checked, with a backup).
    readSshConfig: (file) => call('sshconfig:read', file),
    checkSshConfig: (opts) => call('sshconfig:check', opts),
    writeSshConfig: (opts) => call('sshconfig:write', opts),
    pickKey: () => call('sshconfig:pickKey'),
  },

  teleport: {
    status: () => call('teleport:status'),
    // NAME=value lines for tsh: what they set, and the lines that are not that.
    parseEnv: (text) => call('teleport:parseEnv', text),
    resolveHome: (text) => call('teleport:resolveHome', text),
    homes: () => call('teleport:homes'),
    loginCommand: (opts) => call('teleport:loginCommand', opts),
    nodes: (opts) => call('teleport:nodes', opts),
    clusters: (opts) => call('teleport:clusters', opts),
    switchProfile: (opts) => call('teleport:switchProfile', opts),
    loginMethods: (proxy) => call('teleport:loginMethods', proxy),
    login: (opts) => call('teleport:login', opts),
    logout: (opts) => call('teleport:logout', opts),
    // Deleting a dead profile's files, and what that would delete.
    removeProfile: (opts) => call('teleport:removeProfile', opts),
    profileFiles: (opts) => call('teleport:profileFiles', opts),
    savedLogins: () => call('teleport:savedLogins'),
    saveLogin: (t) => call('teleport:saveLogin', t),
    deleteSavedLogin: (id) => call('teleport:deleteSavedLogin', id),
    markSavedLoginUsed: (id) => call('teleport:markSavedLoginUsed', id),
    requests: (opts) => call('teleport:requests', opts),
    requestShow: (id, opts) => call('teleport:requestShow', id, opts),
    requestAssume: (id, opts) => call('teleport:requestAssume', id, opts),
    requestDrop: (ids, opts) => call('teleport:requestDrop', ids, opts),
    requestCreate: (opts) => call('teleport:requestCreate', opts),
    requestSearch: (opts) => call('teleport:requestSearch', opts),
    inventoryNodeIds: (opts) => call('teleport:inventoryNodeIds', opts),
    inventoryKubeIds: (opts) => call('teleport:inventoryKubeIds', opts),
    createJoinToken: (opts) => call('teleport:createJoinToken', opts),
    nodeInstallCommand: (opts) => call('teleport:nodeInstallCommand', opts),
    requestRoles: (opts) => call('teleport:requestRoles', opts),
    probeRequest: (opts) => call('teleport:probeRequest', opts),
    rolesForResources: (requests, ids) => call('teleport:rolesForResources', requests, ids),
    requestKinds: () => call('teleport:requestKinds'),
    requestPreview: (opts) => call('teleport:requestPreview', opts),
    webapiPing: (opts) => call('teleport:webapiPing', opts),
    statusText: (opts) => call('teleport:statusText', opts),
    activeSessions: (opts) => call('teleport:activeSessions', opts),
    joinArgs: (sid, opts) => call('teleport:joinArgs', sid, opts),
    loginArgs: (opts) => call('teleport:loginArgs', opts),
    latencyArgs: (opts) => call('teleport:latencyArgs', opts),
    // The cluster's web UI: `webClusterUrl` to show or copy the link,
    // `openWebCluster` to hand it to the browser.
    webClusterUrl: (opts) => call('teleport:webClusterUrl', opts),
    openWebCluster: (opts) => call('teleport:openWebCluster', opts),
    savedRequests: (opts) => call('teleport:savedRequests', opts),
    saveRequest: (t) => call('teleport:saveRequest', t),
    deleteSavedRequest: (id) => call('teleport:deleteSavedRequest', id),
    markSavedRequestUsed: (id) => call('teleport:markSavedRequestUsed', id),
  },

  conn: {
    create: (host, opts) => call('conn:create', host, opts),
    connect: (id) => call('conn:connect', id),
    disconnect: (id) => call('conn:disconnect', id),
    list: () => call('conn:list'),
    writeMaster: (id, data) => call('conn:writeMaster', id, data),
    log: (id) => call('conn:log', id),
    exec: (id, cmd) => call('conn:exec', id, cmd),
    // A one-off command that can prompt for MFA — see Connection.execInteractive.
    execInteractive: (id, cmd, opts) => call('conn:execInteractive', id, cmd, opts),
    writeExec: (id, execId, data) => call('conn:writeExec', id, execId, data),
    killExec: (id, execId) => call('conn:killExec', id, execId),
    onExecData: (h) => on('exec:data', h),
    onExecPrompt: (h) => on('exec:prompt', h),
    serverInfo: (id, opts) => call('conn:serverInfo', id, opts),
    teleportPresence: (id, opts) => call('conn:teleportPresence', id, opts),
    startMonitor: (id, opts) => call('conn:startMonitor', id, opts),
    startLocalMonitor: (opts) => call('local:startMonitor', opts),
    stopLocalMonitor: () => call('local:stopMonitor'),
    stopMonitor: (id) => call('conn:stopMonitor', id),
    onMonitor: (h) => on('conn:monitor', h),
    diskSpace: (id, p) => call('conn:diskSpace', id, p),
    shellHistory: (id, opts) => call('conn:shellHistory', id, opts),
    onServerInfo: (h) => on('conn:serverInfo', h),
    onState: (h) => on('conn:state', h),
    onLog: (h) => on('conn:log', h),
    onInfo: (h) => on('conn:info', h),
    onChanged: (h) => on('conn:changed', h),
  },

  x11: {
    status: () => call('x11:status'),
  },

  keys: {
    list: () => call('keys:list'),
    agent: () => call('keys:agent'),
    // A null path runs plain `ssh-add`, loading the default identities.
    addToAgent: (p, opts) => call('keys:addToAgent', p, opts),
    isEncrypted: (p) => call('keys:isEncrypted', p),
    generate: (opts) => call('keys:generate', opts),
    install: (connId, publicKey) => call('keys:install', connId, publicKey),
    knownHosts: (host, ctx) => call('knownhosts:entries', host, ctx),
    forgetHost: (host, ctx) => call('knownhosts:forget', host, ctx),
  },

  forward: {
    add: (connId, fwd) => call('forward:add', connId, fwd),
    remove: (connId, id) => call('forward:remove', connId, id),
    list: (connId) => call('forward:list', connId),
    favorites: () => call('forward:favorites'),
    favoriteAdd: (rec) => call('forward:favoriteAdd', rec),
    favoriteUpdate: (id, patch) => call('forward:favoriteUpdate', id, patch),
    favoriteUsed: (id) => call('forward:favoriteUsed', id),
    favoriteRemove: (id) => call('forward:favoriteRemove', id),
    onUpdate: (h) => on('forward:update', h),
  },

  term: {
    open: (connId, opts) => call('term:open', connId, opts),
    write: (connId, id, data) => call('term:write', connId, id, data),
    resize: (connId, id, cols, rows) => call('term:resize', connId, id, cols, rows),
    close: (connId, id) => call('term:close', connId, id),
    cwd: (connId, id) => call('term:cwd', connId, id),
    startLog: (connId, id, filePath) => call('term:startLog', connId, id, filePath),
    stopLog: (connId, id) => call('term:stopLog', connId, id),
    logState: (connId, id) => call('term:logState', connId, id),
    onLogging: (h) => on('term:logging', h),
    onData: (h) => on('term:data', h),
    onExit: (h) => on('term:exit', h),
  },

  localTerm: {
    open: (opts) => call('localterm:open', opts),
    shells: () => call('localterm:shells'),
    cwd: (id) => call('localterm:cwd', id),
    write: (id, data) => call('localterm:write', id, data),
    resize: (id, cols, rows) => call('localterm:resize', id, cols, rows),
    close: (id) => call('localterm:close', id),
    onData: (h) => on('localterm:data', h),
    onExit: (h) => on('localterm:exit', h),
  },

  /*
   * Serial consoles and telnet. One stream of bytes, no connection behind it:
   * the id names the session and that is the whole of the addressing.
   */
  device: {
    ports: () => call('device:ports'),
    open: (opts) => call('device:open', opts),
    ready: (id) => call('device:ready', id),
    write: (id, data) => call('device:write', id, data),
    resize: (id, cols, rows) => call('device:resize', id, cols, rows),
    sendBreak: (id, ms) => call('device:break', id, ms),
    signals: (id, sig) => call('device:signals', id, sig),
    close: (id) => call('device:close', id),
    onData: (h) => on('device:data', h),
    onExit: (h) => on('device:exit', h),
  },

  /*
   * tmux control mode: sessions that outlive this window. Only the far side
   * needs tmux — the protocol is spoken here.
   */
  tmux: {
    probe: (connId) => call('tmux:probe', connId),
    sessions: (connId) => call('tmux:sessions', connId),
    attach: (connId, opts) => call('tmux:attach', connId, opts),
    write: (id, pane, data) => call('tmux:write', id, pane, data),
    resize: (id, cols, rows) => call('tmux:resize', id, cols, rows),
    capture: (id, pane, lines) => call('tmux:capture', id, pane, lines),
    command: (id, cmd) => call('tmux:command', id, cmd),
    windows: (id) => call('tmux:windows', id),
    detach: (id) => call('tmux:detach', id),
    kill: (id) => call('tmux:kill', id),
    onOutput: (h) => on('tmux:output', h),
    onWindows: (h) => on('tmux:windows', h),
    onLayout: (h) => on('tmux:layout', h),
    onPause: (h) => on('tmux:pause', h),
    onEnded: (h) => on('tmux:ended', h),
  },

  /*
   * A screen rather than a shell. The renderer never names the TCP target
   * twice: it asks for a session, gets back a loopback URL with a one-off
   * token in it, and the main process remembers where that token goes.
   */
  vnc: {
    prepare: (target) => call('vnc:prepare', target),
    release: (token) => call('vnc:release', token),
  },

  rdp: {
    launch: (conn) => call('rdp:launch', conn),
    available: () => call('rdp:available'),
  },

  city: {
    scanLocal: (dir) => call('city:scanLocal', dir),
    scanRemote: (connId, dir) => call('city:scanRemote', connId, dir),
    procsLocal: () => call('city:procsLocal'),
    procsRemote: (connId) => call('city:procsRemote', connId),
  },

  sftp: {
    home: (connId) => call('sftp:home', connId),
    list: (connId, dir) => call('sftp:list', connId, dir),
    realpath: (connId, p) => call('sftp:realpath', connId, p),
    search: (connId, opts) => call('sftp:search', connId, opts),
    mkdir: (connId, p) => call('sftp:mkdir', connId, p),
    rename: (connId, a, b) => call('sftp:rename', connId, a, b),
    chmod: (connId, p, mode) => call('sftp:chmod', connId, p, mode),
    remove: (connId, entries) => call('sftp:remove', connId, entries),
    readFile: (connId, p) => call('sftp:readFile', connId, p),
    writeFile: (connId, p, content) => call('sftp:writeFile', connId, p, content),
  },

  local: {
    home: () => call('local:home'),
    shortcuts: () => call('local:shortcuts'),
    existingDirs: (paths) => call('local:existingDirs', paths),
    search: (opts) => call('local:search', opts),
    list: (dir) => call('local:list', dir),
    mkdir: (p) => call('local:mkdir', p),
    remove: (paths) => call('local:remove', paths),
    rename: (a, b) => call('local:rename', a, b),
    reveal: (p) => call('local:reveal', p),
    open: (p) => call('local:open', p),
    openWith: (p, appPath) => call('local:openWith', p, appPath),
    readText: (p, opts) => call('local:readText', p, opts),
    writeText: (p, text) => call('local:writeText', p, text),
    parent: (p) => call('local:parent', p),
    info: (p) => call('local:info', p),
    treeSize: (p) => call('local:treeSize', p),
    diskSpace: (p) => call('local:diskSpace', p),
  },

  xfer: {
    upload: (connId, localPaths, remoteDir) => call('xfer:upload', connId, localPaths, remoteDir),
    download: (connId, entries, localDir) => call('xfer:download', connId, entries, localDir),
    cross: (srcConnId, entries, destConnId, destDir, opts) => call('xfer:cross', srcConnId, entries, destConnId, destDir, opts),
    crossPlan: (srcConnId, destConnId) => call('xfer:crossPlan', srcConnId, destConnId),
    list: (connId) => call('xfer:list', connId),
    cancel: (connId, jobId) => call('xfer:cancel', connId, jobId),
    clear: (connId) => call('xfer:clear', connId),
    pause: (connId, jobId) => call('xfer:pause', connId, jobId),
    resumeJob: (connId, jobId) => call('xfer:resume', connId, jobId),
    pauseAll: (connId) => call('xfer:pauseAll', connId),
    resumeAll: (connId) => call('xfer:resumeAll', connId),
    retry: (connId, jobId) => call('xfer:retry', connId, jobId),
    move: (connId, jobId, delta) => call('xfer:move', connId, jobId, delta),
    limit: (kbPerSecond) => call('xfer:limit', kbPerSecond),
    onUpdate: (h) => on('xfer:update', h),
  },

  /**
   * Keeping two directories the same. `plan` only looks; `apply` takes the
   * reviewed plan back and moves what is left in it.
   */
  sync: {
    plan: (connId, opts) => call('sync:plan', connId, opts),
    apply: (connId, planned, actions) => call('sync:apply', connId, planned, actions),
  },

  /** Live watches: a mirrored directory, or a remote file open in an editor. */
  watch: {
    list: () => call('watch:list'),
    dir: (connId, opts) => call('watch:dir', connId, opts),
    edit: (connId, remotePath) => call('watch:edit', connId, remotePath),
    stop: (id) => call('watch:stop', id),
    onUpdate: (h) => on('watch:update', h),
  },

  /**
   * The record of files brought down to this machine. Kept apart from `xfer`,
   * which is about transfers in flight: this outlives them, and the session.
   */
  downloads: {
    list: () => call('downloads:list'),
    forget: (id) => call('downloads:forget', id),
    clear: () => call('downloads:clear'),
    check: (paths) => call('downloads:check', paths),
    onUpdate: (h) => on('downloads:update', h),
  },

  multiexec: {
    run: (connIds, command, opts) => call('multiexec:run', connIds, command, opts),
    cancel: (runId) => call('multiexec:cancel', runId),
    decide: (runId, choice) => call('multiexec:decide', runId, choice),
    // Answer a prompt on one host mid-run — the MFA code or tap it is
    // waiting on, same shape as conn.writeExec but routed by runId+connId.
    answer: (runId, connId, data) => call('multiexec:answer', runId, connId, data),
    list: () => call('multiexec:list'),
    clear: () => call('multiexec:clear'),
    history: () => call('multiexec:history'),
    historyAdd: (rec) => call('multiexec:historyAdd', rec),
    historyDelete: (id) => call('multiexec:historyDelete', id),
    historyClear: () => call('multiexec:historyClear'),
    onUpdate: (h) => on('multiexec:update', h),
    onDone: (h) => on('multiexec:done', h),
  },

  ansible: {
    build: (targets, command, opts) => call('ansible:build', targets, command, opts),
    save: (targets, command, opts) => call('ansible:save', targets, command, opts),
    suggestName: (command) => call('ansible:suggestName', command),
  },

  workspace: {
    save: (ws) => call('workspace:save', ws),
    get: () => call('workspace:get'),
    clear: () => call('workspace:clear'),
    others: () => call('workspace:others'),
    listLayouts: () => call('layouts:list'),
    getLayout: (id) => call('layouts:get', id),
    saveLayout: (layout) => call('layouts:save', layout),
    deleteLayout: (id) => call('layouts:delete', id),
    setDefaultLayout: (id) => call('layouts:setDefault', id),
    getDefaultLayout: () => call('layouts:getDefault'),
  },

  mxfile: {
    save: (def) => call('mxfile:save', def),
    preview: (def) => call('mxfile:preview', def),
    load: () => call('mxfile:load'),
    saveResults: (view, opts) => call('mxfile:saveResults', view, opts),
  },

  history: {
    list: (opts) => call('history:list', opts),
    recent: (opts) => call('history:recent', opts),
    clear: () => call('history:clear'),
  },

  recordings: {
    list: (opts) => call('recordings:list', opts),
    webUrl: (opts) => call('recordings:webUrl', opts),
    openWeb: (opts) => call('recordings:openWeb', opts),
    playArgs: (sid, opts) => call('recordings:playArgs', sid, opts),
    search: (opts) => call('recordings:search', opts),
    cancelSearch: () => call('recordings:cancelSearch'),
    text: (sid, opts) => call('recordings:text', sid, opts),
    saveTranscript: (sid, opts) => call('recordings:saveTranscript', sid, opts),
    chooseSaveDir: () => call('recordings:chooseSaveDir'),
    onSearchProgress: (h) => on('recordings:searchProgress', h),
    // Sessions flagged to come back to, with their notes.
    notes: () => call('sessions:notes'),
    saveNote: (rec) => call('sessions:noteSave', rec),
    deleteNote: (sid) => call('sessions:noteDelete', sid),
  },

  dialog: {
    openFiles: (opts) => call('dialog:openFiles', opts),
    openDirs: () => call('dialog:openDirs'),
    chooseDir: (defaultPath) => call('dialog:chooseDir', defaultPath),
    chooseApp: () => call('dialog:chooseApp'),
    confirm: (opts) => call('dialog:confirm', opts),
    saveText: (opts) => call('dialog:saveText', opts),
  },

  clipboard: {
    write: (text) => call('clipboard:write', text),
    read: () => call('clipboard:read'),
  },

  decode: {
    run: (opts) => call('decode:run', opts),
    tshCerts: () => call('decode:tshCerts'),
    pickFile: (kind) => call('decode:pickFile', kind),
  },
  net: {
    curl: (opts) => call('net:curl', opts),
    hostTools: (connId, opts) => call('net:hostTools', connId, opts),
    hostFacts: (connId) => call('net:hostFacts', connId),
    hostPorts: (connId, opts) => call('net:hostPorts', connId, opts),
    hostPing: (connId, opts) => call('net:hostPing', connId, opts),
    hostTrace: (connId, opts) => call('net:hostTrace', connId, opts),
    hostSockets: (connId) => call('net:hostSockets', connId),
    hostCurl: (connId, opts) => call('net:hostCurl', connId, opts),
    curlCommand: (opts) => call('net:curlCommand', opts),
    previewCommand: (opts) => call('net:previewCommand', opts),
    requests: () => call('net:requests'),
    requestSave: (rec) => call('net:requestSave', rec),
    requestDelete: (id) => call('net:requestDelete', id),
    recents: () => call('net:recents'),
    recentAdd: (rec) => call('net:recentAdd', rec),
    recentsClear: () => call('net:recentsClear'),
    ping: (opts) => call('net:ping', opts),
    traceroute: (opts) => call('net:traceroute', opts),
    lookup: (opts) => call('net:lookup', opts),
    portCheck: (opts) => call('net:portCheck', opts),
    tlsInfo: (opts) => call('net:tlsInfo', opts),
    httpCheck: (opts) => call('net:httpCheck', opts),
    whois: (opts) => call('net:whois', opts),
    telnetProbe: (opts) => call('net:telnetProbe', opts),
    localInfo: () => call('net:localInfo'),
    sockets: () => call('net:sockets'),
    pickFile: (title) => call('net:pickFile', title),
  },

  files: {
    // Electron no longer exposes File.path; this is the supported way to turn
    // a dropped File into an on-disk path.
    pathFor: (file) => {
      try { return webUtils.getPathForFile(file); } catch { return null; }
    },
  },
});
