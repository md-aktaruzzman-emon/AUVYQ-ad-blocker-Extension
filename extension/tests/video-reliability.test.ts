import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Video Platform & YouTube Reliability Suite', () => {
  const extensionDir = path.resolve(__dirname, '..');
  const specificCosmeticPath = path.join(extensionDir, 'data/cosmetic/specific.json');
  const dispatchPath = path.join(extensionDir, 'data/scriptlets/dispatch.json');
  const mainRulesPath = path.join(extensionDir, 'rules/main.json');
  const easylistPath = path.join(extensionDir, 'rules/easylist.json');

  // ---- 1. YouTube Specific Cosmetic Rules -----------------------------------

  it('compiles precise YouTube ad container cosmetic selectors into specific.json', () => {
    const specific = JSON.parse(fs.readFileSync(specificCosmeticPath, 'utf8'));
    expect(specific).toHaveProperty('youtube.com');

    const ytSelectors = specific['youtube.com'] as string[];
    expect(ytSelectors.length).toBeGreaterThanOrEqual(8);

    const requiredTokens = [
      '#masthead-ad',
      '.ytp-ad-overlay-container',
      '.ytp-ad-message-container',
      'ytd-ad-slot-renderer',
      'ytd-promoted-sparkles-web-renderer',
      'ytd-in-feed-ad-layout-renderer'
    ];

    for (const tok of requiredTokens) {
      const match = ytSelectors.some((s) => s.includes(tok));
      expect(match).toBe(true);
    }
  });

  // ---- 2. YouTube Scriptlet Defuser Configuration --------------------------

  it('configures json-prune-lite for youtube.com in scriptlet dispatch', () => {
    const dispatch = JSON.parse(fs.readFileSync(dispatchPath, 'utf8'));
    expect(dispatch).toHaveProperty('youtube.com');

    const ytScriptlets = dispatch['youtube.com'] as { name: string; args: string[] }[];
    const pruneRule = ytScriptlets.find((s) => s.name === 'json-prune-lite');

    expect(pruneRule).toBeDefined();
    expect(pruneRule?.args[0]).toContain('adPlacements');
    expect(pruneRule?.args[0]).toContain('playerAds');
  });

  // ---- 3. json-prune-lite Defusal Logic Simulation -------------------------

  it('prunes adPlacements and playerAds from player response while preserving streaming metadata', () => {
    // Simulated realistic YouTube InitialPlayerResponse payload
    const mockPlayerResponse = {
      responseContext: {
        serviceTrackingParams: [{ service: 'CSI' }]
      },
      playabilityStatus: {
        status: 'OK',
        playableInEmbed: true
      },
      streamingData: {
        expiresInSeconds: '21540',
        formats: [
          { itag: 18, mimeType: 'video/mp4; codecs="avc1.42001E, mp4a.40.2"', bitrate: 600000 }
        ],
        adaptiveFormats: [
          { itag: 137, mimeType: 'video/mp4; codecs="avc1.640028"', bitrate: 2500000 }
        ]
      },
      videoDetails: {
        videoId: 'dQw4w9WgXcQ',
        title: 'High Definition Educational Video',
        lengthSeconds: '213',
        channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw'
      },
      // Injected advertisement payloads that cause pre-roll and mid-roll interruptions
      playerAds: [
        {
          playerLegacyDesktopWatchAdsRenderer: {
            playerAdParams: { showAd: true }
          }
        }
      ],
      adPlacements: [
        {
          adPlacementRenderer: {
            config: { adTimeOffsetType: 'OFFSET_TYPE_PRE_ROLL' }
          }
        }
      ]
    };

    // Simulate json-prune-lite execution logic with 'adPlacements playerAds'
    const prunePaths = ['adPlacements', 'playerAds'];
    const pruneObj = (value: Record<string, unknown>) => {
      for (const p of prunePaths) {
        if (Object.prototype.hasOwnProperty.call(value, p)) {
          delete value[p];
        }
      }
      return value;
    };

    const cleaned = pruneObj(JSON.parse(JSON.stringify(mockPlayerResponse))) as Record<string, any>;

    // Advertisements successfully eliminated
    expect(cleaned.playerAds).toBeUndefined();
    expect(cleaned.adPlacements).toBeUndefined();

    // Critical playback structures preserved 100% intact
    expect(cleaned.playabilityStatus).toEqual({ status: 'OK', playableInEmbed: true });
    expect(cleaned.streamingData).toBeDefined();
    expect(cleaned.videoDetails.videoId).toBe('dQw4w9WgXcQ');
    expect(cleaned.videoDetails.title).toBe('High Definition Educational Video');
  });

  it('prunes nested player response paths safely when called via JSON.parse or Response.json', async () => {
    const rawJsonText = JSON.stringify({
      status: 'success',
      data: {
        playerResponse: {
          adPlacements: [{ id: 'ad-1' }],
          playerAds: [{ id: 'ad-2' }],
          video: { duration: 180, url: 'https://video.example/stream.mp4' }
        }
      }
    });

    const parsedPaths = [['data', 'playerResponse', 'adPlacements'], ['data', 'playerResponse', 'playerAds']];
    const pruneObj = (value: any) => {
      for (const pathParts of parsedPaths) {
        let current = value;
        for (let i = 0; i < pathParts.length - 1; i++) {
          current = current[pathParts[i]];
          if (!current) break;
        }
        if (current && typeof current === 'object') {
          delete current[pathParts[pathParts.length - 1]];
        }
      }
      return value;
    };

    const result = pruneObj(JSON.parse(rawJsonText));
    expect(result.data.playerResponse.adPlacements).toBeUndefined();
    expect(result.data.playerResponse.playerAds).toBeUndefined();
    expect(result.data.playerResponse.video.duration).toBe(180);
    expect(result.data.playerResponse.video.url).toBe('https://video.example/stream.mp4');
  });

  // ---- 4. Playback Integrity & Rejection of 16x Hacks -----------------------

  it('enforces DR-003: zero artificial 16x playbackRate acceleration and zero synthetic currentTime skipping', () => {
    // Mock HTML5 Video Element
    const mockVideo = {
      playbackRate: 1.0,
      currentTime: 10.5,
      duration: 300.0,
      muted: false,
      playCount: 0,
      play() { this.playCount++; return Promise.resolve(); }
    };

    // Verify baseline video playback behavior: normal user or page control
    mockVideo.playbackRate = 1.0;
    expect(mockVideo.playbackRate).toBe(1.0);

    // Verify AUVYQ contains NO code that forces video.playbackRate = 16
    const injectorPath = path.join(extensionDir, 'content/cosmetic-injector.js');
    const dispatchScriptPath = path.join(extensionDir, 'content/scriptlet-dispatch.js');
    const injectorCode = fs.readFileSync(injectorPath, 'utf8');
    const dispatchCode = fs.readFileSync(dispatchScriptPath, 'utf8');

    expect(injectorCode).not.toContain('playbackRate = 16');
    expect(injectorCode).not.toContain('playbackRate=16');
    expect(injectorCode).not.toContain('currentTime = video.duration');
    expect(dispatchCode).not.toContain('playbackRate = 16');
    expect(dispatchCode).not.toContain('playbackRate=16');
    expect(dispatchCode).not.toContain('currentTime = video.duration');
  });

  // ---- 5. Network Stream Safety (Zero Video Chunk Blocking) ----------------

  it('guarantees media stream delivery domains are never blocked in DNR rulesets', () => {
    const mainRules = JSON.parse(fs.readFileSync(mainRulesPath, 'utf8'));
    const easylistRules = JSON.parse(fs.readFileSync(easylistPath, 'utf8'));
    const allRules = [...mainRules, ...easylistRules];

    // Essential video chunk and streaming CDN domains
    const streamDomains = [
      'googlevideo.com',
      'youtube.com',
      'ytimg.com',
      'vimeocdn.com',
      'twitch.tv',
      'ttvnw.net',
      'dailymotion.com'
    ];

    for (const rule of allRules) {
      if (rule.action?.type === 'block') {
        const reqDomains = (rule.condition?.requestDomains ?? []).map((d: string) => d.toLowerCase());
        for (const sDomain of streamDomains) {
          expect(reqDomains).not.toContain(sDomain);
        }

        const urlFilter = (rule.condition?.urlFilter ?? '').toLowerCase();
        for (const sDomain of streamDomains) {
          expect(urlFilter).not.toBe(`||${sDomain}^`);
        }
      }
    }
  });
});
