// What the spec asks a client to show before opening a URL-mode link:
// the full URL, the domain called out, and warnings for suspicious hosts.
// The client must not fetch the URL itself.

export interface UrlReview {
    full: string;
    host: string;
    warnings: string[];
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function reviewUrl(raw: string): UrlReview {
    let url: URL;
    try {
        url = new URL(raw);
    } catch {
        return { full: raw, host: '(invalid URL)', warnings: ['This is not a valid URL. Do not open it.'] };
    }
    const warnings: string[] = [];
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        warnings.push(`Unusual scheme "${url.protocol}". Only web links are expected.`);
    } else if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
        warnings.push('Not HTTPS: anything you type there could be read in transit.');
    }
    if (url.hostname.split('.').some(label => label.startsWith('xn--'))) {
        warnings.push('The domain uses Punycode and may imitate a different site.');
    }
    if (url.username || url.password) {
        warnings.push('The link contains a username or password.');
    }
    return { full: url.href, host: url.host, warnings };
}
