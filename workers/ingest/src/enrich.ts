/**
 * Server-side enrichment (PROJECT_PLAN.md §5) — filled in step 3.
 *
 * Not sent by the client (anti-forgery): geo from request.cf, ASN → asn_type,
 * UA parse (browser/os/device_type), IP → truncated SHA256 hash + /24 segment
 * hash, URL → UTM / click_id columns + extra_params.
 */

export {};
