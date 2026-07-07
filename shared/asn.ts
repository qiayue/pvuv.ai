/**
 * Datacenter ASN detection — PROJECT_PLAN.md §5, §6.1.
 *
 * Maps request.cf.asn / cf.asOrganization to an asn_type used by the scorer
 * (0x0008 datacenter signal, residential/mobile trust credit). M1 ships a
 * small embedded list of major hosting/cloud ASNs plus an org-name keyword
 * match; a fuller datacenter DB (and residential/mobile classification) is
 * M2+ — the scorer only reads asn_type, so improving detection later needs
 * no scoring changes.
 */

export type AsnType = 'datacenter' | 'residential' | 'mobile' | 'unknown';

/** Major hosting / cloud ASNs (not exhaustive — M2 swaps in a real DB). */
const DATACENTER_ASNS = new Set<number>([
  16509, 14618, // Amazon AWS
  396982, // Google Cloud
  8075, // Microsoft Azure
  14061, // DigitalOcean
  16276, // OVH
  24940, 213230, // Hetzner
  63949, // Linode / Akamai
  20473, // Vultr / Choopa
  45102, // Alibaba Cloud
  132203, 45090, // Tencent Cloud
  31898, // Oracle Cloud
  51167, // Contabo
  197540, // netcup
  60781, // LeaseWeb
  9009, // M247
  212238, // Datacamp / CDN77
  46606, // Unified Layer / Bluehost
  26496, // GoDaddy hosting
  55990, // Huawei Cloud
]);

const ORG_KEYWORDS = [
  'hosting', 'datacenter', 'data center', 'server', 'cloud', 'vps',
  'dedicated', 'colocation', 'colo ', 'digitalocean', 'linode', 'vultr',
  'hetzner', 'ovh', 'aws', 'amazon', 'google cloud', 'azure', 'alibaba',
  'tencent cloud', 'oracle cloud',
];

/**
 * Classify the origin network of a request.
 * @param asn    request.cf.asn (may be missing in local dev)
 * @param asOrg  request.cf.asOrganization
 */
export function classifyAsn(asn: number | undefined, asOrg: string | undefined): AsnType {
  if (asn !== undefined && DATACENTER_ASNS.has(asn)) return 'datacenter';
  if (asOrg) {
    const org = asOrg.toLowerCase();
    if (ORG_KEYWORDS.some((k) => org.includes(k))) return 'datacenter';
  }
  // M2+: residential/mobile classification via a proper ASN-type DB.
  return 'unknown';
}
