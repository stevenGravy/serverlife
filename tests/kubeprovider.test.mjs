import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

const require_ = createRequire(import.meta.url);
const kp = require_(path.join(__PROJECT_ROOT__, 'src/main/kubeprovider.js'));

const node = (name, labels = {}, providerID = '', ready = true, kubelet = 'v1.35.9') => ({
  metadata: { name, labels }, spec: { providerID },
  status: { conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }], nodeInfo: { kubeletVersion: kubelet } },
});

test('kubeconfig: an EKS context ARN gives region, account and name', () => {
  const p = kp.fromKubeconfig({ contextName: 'arn:aws:eks:us-west-2:123456789012:cluster/shared', server: 'https://ABC.gr7.us-west-2.eks.amazonaws.com' });
  assert.equal(p.provider, 'eks');
  assert.deepEqual([p.region, p.account, p.clusterName, p.how], ['us-west-2', '123456789012', 'shared', 'kubeconfig']);
});

test('kubeconfig: an EKS endpoint (GovCloud too) or aws eks get-token, with region and name from the args', () => {
  const gov = kp.fromKubeconfig({ contextName: 'fips', server: 'https://99E7.yl4.us-gov-west-1.eks.amazonaws.com', exec: { command: 'aws', args: ['--region', 'us-gov-west-1', 'eks', 'get-token', '--cluster-name', 'fips'] } });
  assert.deepEqual([gov.provider, gov.region, gov.clusterName], ['eks', 'us-gov-west-1', 'fips']);
  const viaExec = kp.fromKubeconfig({ contextName: 'x', server: 'https://10.0.0.1', exec: { command: '/usr/local/bin/aws', args: ['eks', 'get-token', '--cluster-name=prod', '--region=eu-west-1'] } });
  assert.deepEqual([viaExec.provider, viaExec.region, viaExec.clusterName], ['eks', 'eu-west-1', 'prod']);
  assert.equal(kp.fromKubeconfig({ contextName: 'y', exec: { command: 'aws-iam-authenticator', args: ['token', '-i', 'old'] } }).clusterName, 'old');
});

test('kubeconfig: GKE from gke_<project>_<location>_<name> or gke-gcloud-auth-plugin', () => {
  const p = kp.fromKubeconfig({ contextName: 'gke_my-project-1_us-central1_web', server: 'https://34.1.2.3' });
  assert.deepEqual([p.provider, p.project, p.location, p.clusterName], ['gke', 'my-project-1', 'us-central1', 'web']);
  assert.equal(kp.fromKubeconfig({ contextName: 'renamed', server: 'https://34.1.2.3', exec: { command: 'gke-gcloud-auth-plugin' } }).provider, 'gke');
});

test('kubeconfig: AKS from its azmk8s.io endpoint or kubelogin', () => {
  const p = kp.fromKubeconfig({ contextName: 'web-aks', clusterName: 'web-aks', server: 'https://web-aks-dns-abc123.hcp.eastus.azmk8s.io:443' });
  assert.deepEqual([p.provider, p.region], ['aks', 'eastus']);
  assert.equal(kp.fromKubeconfig({ contextName: 'z', server: 'https://10.1.1.1', exec: { command: 'kubelogin', args: ['get-token'] } }).provider, 'aks');
});

test('kubeconfig: local clusters by their usual names; a cluster reached through Teleport says nothing', () => {
  assert.equal(kp.fromKubeconfig({ contextName: 'minikube' }).provider, 'minikube');
  assert.equal(kp.fromKubeconfig({ contextName: 'kind-dev' }).provider, 'kind');
  assert.equal(kp.fromKubeconfig({ contextName: 'docker-desktop' }).provider, 'docker-desktop');
  assert.equal(kp.fromKubeconfig({ contextName: 'k3d-lab' }).provider, 'k3s');
  assert.equal(kp.fromKubeconfig({ contextName: 'teleport.example.com-dev', server: 'https://teleport.example.com:443', exec: { command: 'tsh', args: ['kube', 'credentials'] } }), null);
});

test("Teleport labels: teleport.dev/cloud, cloud, and tags copied in as aws/…, gcp/… or azure/…", () => {
  assert.equal(kp.fromLabels({ 'teleport.dev/cloud': 'AWS', region: 'us-east-1', 'account-id': '123456789012' }).account, '123456789012');
  assert.equal(kp.fromLabels({ cloud: 'aws', location: 'us-west-2' }).region, 'us-west-2');
  assert.equal(kp.fromLabels({ 'aws/env': 'dev' }).provider, 'eks');
  assert.equal(kp.fromLabels({ cloud: 'gcp' }).provider, 'gke');
  assert.equal(kp.fromLabels({ 'azure/aks-managed-poolName': 'agentpool' }).provider, 'aks');
  assert.equal(kp.fromLabels({ env: 'demo', owner: 'me' }), null);
});

test('a name alone is a guess, and said as one', () => {
  const p = kp.combine(kp.fromName('prod-eks'));
  assert.deepEqual([p.provider, p.how, p.guess], ['eks', 'name', true]);
  assert.equal(kp.fromName('weeks'), null, 'not inside a word');
});

test('the cluster itself: version and node labels name the managed service; providerID alone names the cloud', () => {
  assert.equal(kp.fromCluster({ version: 'v1.35.9-eks-577a51e' }).provider, 'eks');
  assert.equal(kp.fromCluster({ version: 'v1.35.8-gke.1796000' }).provider, 'gke');
  const aks = kp.fromCluster({ version: 'v1.32.11', nodes: [node('a', { 'kubernetes.azure.com/agentpool': 'agentpool', 'topology.kubernetes.io/region': 'westus' }, 'azure:///subscriptions/x/resourceGroups/mc/providers/Microsoft.Compute/virtualMachineScaleSets/aks-agentpool/virtualMachines/0')] });
  assert.deepEqual([aks.provider, aks.region], ['aks', 'westus']);
  const kops = kp.fromCluster({ version: 'v1.30.1', nodes: [node('n', {}, 'aws:///us-east-1a/i-0abc')] });
  assert.deepEqual([kops.provider, kops.managed, kops.short], ['eks', false, 'AWS']);
  assert.equal(kp.fromCluster({ nodes: [node('m', { 'minikube.k8s.io/name': 'minikube' })] }).provider, 'minikube');
  assert.equal(kp.fromCluster({ nodes: [node('k', {}, 'kind://docker/kind/kind-control-plane')] }).provider, 'kind');
});

test('combining: the surest source names it, the others fill in what it lacks', () => {
  const p = kp.combine(kp.fromName('prod-eks'), kp.fromLabels({ cloud: 'aws', location: 'us-west-2' }), kp.fromCluster({ version: 'v1.35.9-eks-1' }));
  assert.deepEqual([p.provider, p.how, p.region, p.guess], ['eks', 'cluster', 'us-west-2', false]);
});

test('console links for EKS (GovCloud too), GKE and AKS — and none without enough to build one', () => {
  assert.equal(kp.consoleUrl({ provider: 'eks', region: 'us-west-2' }, 'shared'), 'https://console.aws.amazon.com/eks/home?region=us-west-2#/clusters/shared');
  assert.match(kp.consoleUrl({ provider: 'eks', region: 'us-gov-west-1' }, 'fips'), /^https:\/\/console\.amazonaws-us-gov\.com\//);
  assert.equal(kp.consoleUrl({ provider: 'gke', project: 'p1', location: 'us-central1' }, 'web'),
    'https://console.cloud.google.com/kubernetes/clusters/details/us-central1/web/details?project=p1');
  assert.match(kp.consoleUrl({ provider: 'aks', subscription: 's', resourceGroup: 'rg' }, 'web'), /managedClusters\/web\/overview$/);
  assert.equal(kp.consoleUrl({ provider: 'aks', region: 'eastus' }, 'web'), '', 'AKS needs a subscription and resource group');
  assert.equal(kp.consoleUrl({ provider: 'eks', region: 'us-east-1', managed: false }, 'kops'), '', 'not EKS: no EKS page');
});

test('EKS node pools: managed node groups, Karpenter, Fargate, with machines, capacity, zones and readiness', () => {
  const nodes = [
    node('a', { 'eks.amazonaws.com/nodegroup': 'ng-1', 'eks.amazonaws.com/capacityType': 'ON_DEMAND', 'node.kubernetes.io/instance-type': 't3.xlarge', 'topology.kubernetes.io/zone': 'us-west-2a' }),
    node('b', { 'eks.amazonaws.com/nodegroup': 'ng-1', 'eks.amazonaws.com/capacityType': 'ON_DEMAND', 'node.kubernetes.io/instance-type': 't3.xlarge', 'topology.kubernetes.io/zone': 'us-west-2b' }, '', false),
    node('c', { 'karpenter.sh/nodepool': 'spot', 'karpenter.sh/capacity-type': 'spot', 'node.kubernetes.io/instance-type': 'm7g.large' }),
    node('d', { 'eks.amazonaws.com/compute-type': 'fargate' }),
  ];
  const pools = kp.nodePools(nodes, 'eks');
  const ng = pools.find((p) => p.name === 'ng-1');
  assert.deepEqual([ng.kind, ng.nodes, ng.ready, ng.types, ng.capacity, ng.zones, ng.selector],
    ['nodegroup', 2, 1, ['t3.xlarge'], ['ON_DEMAND'], ['us-west-2a', 'us-west-2b'], 'eks.amazonaws.com/nodegroup=ng-1']);
  assert.equal(pools.find((p) => p.kind === 'karpenter').selector, 'karpenter.sh/nodepool=spot');
  assert.equal(pools.find((p) => p.kind === 'fargate').selector, 'eks.amazonaws.com/compute-type=fargate');
});

test('GKE and AKS pools: Spot, system/user mode, and no zone called "0"', () => {
  const g = kp.nodePools([node('g', { 'cloud.google.com/gke-nodepool': 'default-pool', 'cloud.google.com/gke-spot': 'true', 'topology.kubernetes.io/zone': 'us-central1-a' })], 'gke')[0];
  assert.deepEqual([g.name, g.capacity, g.selector], ['default-pool', ['Spot'], 'cloud.google.com/gke-nodepool=default-pool']);
  const a = kp.nodePools([node('a', { 'kubernetes.azure.com/agentpool': 'agentpool', 'kubernetes.azure.com/mode': 'system', 'topology.kubernetes.io/zone': '0' })], 'aks')[0];
  assert.deepEqual([a.name, a.mode, a.capacity, a.zones], ['agentpool', 'system', ['Regular'], []]);
});

test('cloud identities from service account annotations: IRSA, GKE and Azure Workload Identity', () => {
  const sa = (ns, name, annotations) => ({ metadata: { namespace: ns, name, annotations } });
  const ids = kp.cloudIdentities([
    sa('kube-system', 'ebs', { 'eks.amazonaws.com/role-arn': 'arn:aws:iam::123456789012:role/ebs' }),
    sa('app', 'web', { 'iam.gke.io/gcp-service-account': 'web@p.iam.gserviceaccount.com' }),
    sa('app', 'api', { 'azure.workload.identity/client-id': '00000000-0000-0000-0000-000000000000' }),
    sa('app', 'plain', {}),
  ]);
  assert.deepEqual(ids.map((i) => [i.namespace + '/' + i.name, i.cloud, i.via]), [
    ['app/api', 'aks', 'Workload Identity'], ['app/web', 'gke', 'Workload Identity'], ['kube-system/ebs', 'eks', 'IRSA'],
  ]);
});

test("EKS's aws-auth: roles, users and accounts with their Kubernetes users and groups", () => {
  const maps = kp.awsAuthMappings({ data: {
    mapRoles: '- rolearn: arn:aws:iam::123456789012:role/nodes\n  username: system:node:{{EC2PrivateDNSName}}\n  groups: [system:bootstrappers, system:nodes]\n',
    mapUsers: '- userarn: arn:aws:iam::123456789012:user/admin\n  username: admin\n  groups: [system:masters]\n',
  } });
  assert.deepEqual(maps.map((m) => [m.kind, m.username, m.groups.join(',')]), [
    ['role', 'system:node:{{EC2PrivateDNSName}}', 'system:bootstrappers,system:nodes'], ['user', 'admin', 'system:masters'],
  ]);
  assert.equal(kp.awsAuthMappings(null), null);
});

test('summarize: the provider from the cluster wins over a guess, and GKE Autopilot is spotted', () => {
  const s = kp.summarize({ provider: kp.combine(kp.fromName('cluster-aks')), version: 'v1.35.8-gke.1', nodes: [node('n', { 'cloud.google.com/gke-nodepool': 'pool-1', 'autopilot.gke.io/x': 'y' })] });
  assert.deepEqual([s.provider.provider, s.provider.how, s.autopilot, s.nodes, s.awsAuth], ['gke', 'cluster', true, 1, null]);
});

test('a cloud set by hand outranks every detected answer, and keeps their details', () => {
  const manual = { provider: 'aks', how: 'manual', short: 'AKS', subscription: 's1' };
  const p = kp.combine(kp.fromCluster({ version: 'v1.35.9-eks-1' }), manual, kp.fromLabels({ cloud: 'azure', 'resource-group': 'rg1' }));
  assert.deepEqual([p.provider, p.how, p.subscription, p.resourceGroup], ['aks', 'manual', 's1', 'rg1']);
});

/* ---- Kubernetes heartbeats: what kubectl's answer to GET /readyz means ---- */
const kr = require_(path.join(__PROJECT_ROOT__, 'src/main/kuberesources.js'));
const beat = (stderr, ok = false, stdout = '') => kr.heartbeatState(ok, stdout, stderr).state;

test('heartbeat: ok, and a 403 is a cluster that answered', () => {
  assert.equal(beat('', true, 'ok'), 'ok');
  assert.equal(beat('Error from server (Forbidden): forbidden: User "x" cannot get path "/readyz"'), 'ok');
});

test('heartbeat: refused credentials, a missing sign-in plugin and MFA are not "down"', () => {
  assert.equal(beat('error: You must be logged in to the server (Unauthorized)'), 'login');
  assert.equal(beat('Install gke-gcloud-auth-plugin for use with kubectl by following https://cloud.google.com/x'), 'login');
  assert.equal(beat('ERROR: access denied: per-session MFA required'), 'mfa');
});

test('heartbeat: timeouts, an unreachable agent and a not-ready API server are told apart', () => {
  assert.equal(beat('Unable to connect to the server: dial tcp 10.0.0.1:443: i/o timeout'), 'timeout');
  assert.equal(beat('ERROR: kubernetes cluster "dev" is not found'), 'agent');
  assert.equal(beat('Error from server (InternalError): readyz check failed'), 'notready');
});

test('heartbeat: a role with no Kubernetes access is said as such, not as the cluster failing', () => {
  assert.equal(beat("NotFound: Your user's Teleport role does not allow Kubernetes access. Please ask cluster administrator to ensure your role has appropriate kubernetes_groups and kubernetes_users set."), 'noaccess');
});
