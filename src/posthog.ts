/**
 * One server-side PostHog event, anonymous: a random distinct id per event,
 * no person profile, and no GeoIP (the request would come from Cloudflare's
 * IP, not the visitor's; country is passed in from `cf` instead). Never
 * throws: analytics must not break a redirect.
 */
export async function capture(
    key: string | undefined,
    host: string,
    event: string,
    properties: Record<string, unknown>,
): Promise<void> {
    if (!key) return
    try {
        const res = await fetch(`${host}/i/v0/e/`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                api_key: key,
                event,
                distinct_id: crypto.randomUUID(),
                properties: {
                    $process_person_profile: false,
                    $geoip_disable: true,
                    ...properties,
                },
                timestamp: new Date().toISOString(),
            }),
        })
        if (!res.ok) console.error('posthog capture failed:', res.status)
    } catch (err) {
        console.error('posthog capture error:', err)
    }
}
