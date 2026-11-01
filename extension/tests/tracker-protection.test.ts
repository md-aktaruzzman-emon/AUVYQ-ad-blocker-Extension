import { describe, it, expect } from 'vitest';
import {
  classifyTrackerRequest,
  isThirdPartyHost,
  TRACKER_REGISTRY
} from '../core/tracker-registry/classifier.js';

describe('Advanced Tracker Protection & Request Classification', () => {
  describe('Tracker Registry & Entity Recognition', () => {
    it('accurately identifies advertising tracking domains and assigns correct entities', () => {
      const adRequests = [
        { url: 'https://securepubads.g.doubleclick.net/gampad/ads', entity: 'Google', cat: 'advertising' },
        { url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', entity: 'Google', cat: 'advertising' },
        { url: 'https://ib.adnxs.com/seg?add=1', entity: 'AppNexus / Xandr', cat: 'advertising' },
        { url: 'https://static.criteo.net/js/ld/ld.js', entity: 'Criteo', cat: 'advertising' },
        { url: 'https://fastlane.rubiconproject.com/a/api/fastlane.json', entity: 'Magnite / Rubicon', cat: 'advertising' },
        { url: 'https://hbopenbid.pubmatic.com/translator', entity: 'PubMatic', cat: 'advertising' },
        { url: 'https://cdn.taboola.com/libtrc/unip/loader.js', entity: 'Taboola', cat: 'advertising' },
        { url: 'https://widgets.outbrain.com/outbrain.js', entity: 'Outbrain', cat: 'advertising' },
        { url: 'https://aax.amazon-adsystem.com/e/dtb/bid', entity: 'Amazon', cat: 'advertising' }
      ];

      for (const req of adRequests) {
        const result = classifyTrackerRequest(req.url, 'https://example-news.com/article');
        expect(result.isTracker, `Expected ${req.url} to be classified as tracker`).toBe(true);
        expect(result.category).toBe(req.cat);
        expect(result.entity).toBe(req.entity);
        expect(result.isThirdParty).toBe(true);
      }
    });

    it('accurately identifies analytics, social, and telemetry tracking domains', () => {
      const analyticsRequests = [
        { url: 'https://www.google-analytics.com/g/collect?v=2', entity: 'Google', cat: 'analytics' },
        { url: 'https://www.googletagmanager.com/gtm.js?id=GTM-1234', entity: 'Google', cat: 'analytics' },
        { url: 'https://api.mixpanel.com/track/', entity: 'Mixpanel', cat: 'analytics' },
        { url: 'https://cdn.segment.com/analytics.js/v1/key/analytics.min.js', entity: 'Twilio Segment', cat: 'analytics' },
        { url: 'https://api.amplitude.com/2/httpapi', entity: 'Amplitude', cat: 'analytics' },
        { url: 'https://connect.facebook.net/en_US/fbevents.js', entity: 'Meta', cat: 'social' },
        { url: 'https://analytics.tiktok.com/i18n/pixel/events.js', entity: 'ByteDance', cat: 'social' },
        { url: 'https://static.ads-twitter.com/uwt.js', entity: 'X / Twitter', cat: 'social' },
        { url: 'https://px.ads.linkedin.com/collect', entity: 'Microsoft', cat: 'social' },
        { url: 'https://browser-intake-datadoghq.com/api/v2/rum', entity: 'Datadog', cat: 'telemetry' },
        { url: 'https://app.appsflyer.com/com.example', entity: 'AppsFlyer', cat: 'telemetry' }
      ];

      for (const req of analyticsRequests) {
        const result = classifyTrackerRequest(req.url, 'https://shopping-site.com/cart');
        expect(result.isTracker, `Expected ${req.url} to be recognized`).toBe(true);
        expect(result.category).toBe(req.cat);
        expect(result.entity).toBe(req.entity);
      }
    });

    it('accurately identifies session replay and behavior recording trackers', () => {
      const replayRequests = [
        { url: 'https://static.hotjar.com/c/hotjar-12345.js', entity: 'Hotjar', cat: 'session_replay' },
        { url: 'https://edge.fullstory.com/s/fs.js', entity: 'FullStory', cat: 'session_replay' },
        { url: 'https://cdn.logrocket.io/logger.min.js', entity: 'LogRocket', cat: 'session_replay' },
        { url: 'https://rec.smartlook.com/recorder.js', entity: 'Smartlook', cat: 'session_replay' },
        { url: 'https://www.clarity.ms/tag/clarity.js', entity: 'Microsoft', cat: 'session_replay' },
        { url: 'https://cdn.mouseflow.com/projects/xyz.js', entity: 'Mouseflow', cat: 'session_replay' }
      ];

      for (const req of replayRequests) {
        const result = classifyTrackerRequest(req.url, 'https://bank.example/account');
        expect(result.isTracker).toBe(true);
        expect(result.category).toBe(req.cat);
        expect(result.entity).toBe(req.entity);
      }
    });
  });

  describe('First-Party vs Third-Party Boundary Detection', () => {
    it('correctly discriminates third-party trackers from same-site requests', () => {
      expect(isThirdPartyHost('doubleclick.net', 'nytimes.com')).toBe(true);
      expect(isThirdPartyHost('analytics.google.com', 'google.com')).toBe(false);
      expect(isThirdPartyHost('subdomain.shop.co.uk', 'shop.co.uk')).toBe(false);
      expect(isThirdPartyHost('cdn.mysite.com', 'mysite.com')).toBe(false);
      expect(isThirdPartyHost('facebook.net', 'mysite.com')).toBe(true);
    });

    it('identifies generic tracking paths in third-party contexts', () => {
      const result = classifyTrackerRequest(
        'https://unlisted-ad-server.example/collect?id=123',
        'https://my-blog.com/post'
      );
      expect(result.isTracker).toBe(true);
      expect(result.category).toBe('analytics');
      expect(result.isThirdParty).toBe(true);
    });
  });

  describe('First-Party CNAME Cloaking Detection', () => {
    it('detects tracking endpoints masquerading as first-party subdomains', () => {
      const cloaked = [
        'https://metrics.ecommerce.com/collect?tid=UA-1234',
        'https://analytics.mysite.org/pixel.gif',
        'https://telemetry.webportal.net/track/events',
        'https://data-track.company.com/event'
      ];

      for (const url of cloaked) {
        const parsed = new URL(url);
        const parentSite = `https://${parsed.hostname.split('.').slice(1).join('.')}/index`;
        const result = classifyTrackerRequest(url, parentSite, 'xmlhttprequest');
        expect(result.isTracker).toBe(true);
        expect(result.cnameCloaked).toBe(true);
        expect(result.category).toBe('analytics');
      }
    });

    it('does not flag normal first-party subdomains as CNAME cloaking', () => {
      const normal = [
        'https://api.ecommerce.com/user/profile',
        'https://cdn.mysite.org/styles/main.css',
        'https://app.webportal.net/dashboard',
        'https://auth.company.com/oauth/authorize'
      ];

      for (const url of normal) {
        const parsed = new URL(url);
        const parentSite = `https://${parsed.hostname.split('.').slice(1).join('.')}/index`;
        const result = classifyTrackerRequest(url, parentSite);
        expect(result.isTracker).toBe(false);
        expect(result.cnameCloaked).toBe(false);
      }
    });
  });

  describe('Legitimate Functionality Protection', () => {
    it('never flags essential APIs, CDN libraries, or search endpoints as trackers', () => {
      const benign = [
        'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/react.min.js',
        'https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js',
        'https://fonts.googleapis.com/css2?family=Roboto:wght@400;700',
        'https://api.github.com/repos/auvyq/extension',
        'https://en.wikipedia.org/wiki/Ad_blocking',
        'https://www.google.com/search?q=weather'
      ];

      for (const url of benign) {
        const result = classifyTrackerRequest(url, 'https://example.com/');
        expect(result.isTracker).toBe(false);
        expect(result.category).toBe('none');
      }
    });
  });
});
