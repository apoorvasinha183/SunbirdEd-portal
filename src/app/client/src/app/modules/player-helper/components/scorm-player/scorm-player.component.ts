// scorm-player.component.ts
// Purpose: Thin UI shell that renders a SCORM package in an iframe.
//
// Follows the same contract as sunbird-pdf-player, sunbird-video-player, etc.:
//   @Input()  playerConfig     — content metadata + context
//   @Output() playerEvent      — lifecycle events (START, END, ERROR)
//   @Output() telemetryEvent   — telemetry events (START, END for content read)
//
// All SCORM API logic is delegated to ScormService.
// All persistence flows through the existing content-state-update API.

import { Component, Input, Output, EventEmitter, OnInit, OnDestroy } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { ScormService, ScormSessionConfig } from '../../service/scorm.service';

@Component({
  selector: 'app-scorm-player',
  templateUrl: './scorm-player.component.html',
  styleUrls: ['./scorm-player.component.scss']
})
export class ScormPlayerComponent implements OnInit, OnDestroy {

  // Same interface as every other Sunbird player
  @Input() playerConfig: any;
  @Output() playerEvent = new EventEmitter<any>();
  @Output() telemetryEvent = new EventEmitter<any>();

  // Template-bound state
  contentUrl: SafeResourceUrl;
  loading = true;
  errorMessage: string | null = null;

  // Internal reference to session config
  private sessionConfig: ScormSessionConfig;

  constructor(
    private sanitizer: DomSanitizer,
    private scormService: ScormService
  ) {}


  ngOnInit(): void {
    this.initialize();
  }


  // -------------------------------------------------------------------
  // Initialization sequence — order matters
  // -------------------------------------------------------------------

  private async initialize(): Promise<void> {
    try {
      // Step 1: Extract session config from Sunbird's playerConfig
      this.sessionConfig = this.buildSessionConfig();

      // Step 2: Create SCORM API on window (must happen before iframe loads)
      this.scormService.initializeApi(this.sessionConfig);

      // Step 3: Restore previously saved CMI data from Lern BB.
      // Uses the existing content/state/read API — same as all players.
      // Fails gracefully if Lern BB isn't running.
      await this.scormService.restoreCmiData();

      // Step 4: Wire commit handler to persist CMI via existing API
      this.scormService.registerCommitHandler({
        onInitialize: () => this.emitTelemetry('START'),
        onFinish:     () => { this.emitTelemetry('END'); this.emitPlayer('END'); }
      });

      // Step 5: Build and validate the iframe URL
      this.contentUrl = this.buildContentUrl();

      // Step 6: Done — show the iframe
      this.loading = false;
      this.emitPlayer('START');
      this.emitTelemetry('START');

    } catch (error) {
      this.errorMessage = error.message || 'Failed to load SCORM content';
      this.loading = false;
      this.emitPlayer('ERROR', { error: this.errorMessage });
    }
  }


  // -------------------------------------------------------------------
  // Build session config from Sunbird's playerConfig
  // -------------------------------------------------------------------
  // playerConfig.metadata comes from Knowlg content/v3/read.
  // playerConfig.context comes from the course/collection player.
  // -------------------------------------------------------------------

  private buildSessionConfig(): ScormSessionConfig {
    const meta = this.playerConfig?.metadata || {};
    const ctx  = this.playerConfig?.context  || {};
    return {
      contentId:    meta.identifier,
      userId:       ctx.uid || 'anonymous',
      courseId:     ctx.courseId || meta.identifier,
      batchId:      ctx.batchId || 'default',
      scormVersion: String(meta.scormVersion || '').includes('2004') ? '2004' : '1.2'
    };
  }


  // -------------------------------------------------------------------
  // Build the iframe src URL
  // -------------------------------------------------------------------
  // Priority: streamingUrl > previewUrl > artifactUrl
  //
  // If the URL is on a different origin than the portal, route it
  // through /content-storage to avoid iframe CORS.
  // -------------------------------------------------------------------

  private buildContentUrl(): SafeResourceUrl {
    const meta = this.playerConfig?.metadata || {};
    const launchFile = meta.scormLaunchUrl || 'index_lms.html';

    // Determine the base URL for the extracted SCORM package
    let baseUrl = meta.streamingUrl || meta.previewUrl;
    if (!baseUrl && meta.artifactUrl) {
      // artifactUrl points to the .zip; the extracted folder is at the same level
      baseUrl = meta.artifactUrl.substring(0, meta.artifactUrl.lastIndexOf('/'));
    }
    if (!baseUrl) {
      throw new Error('No content URL in metadata (streamingUrl, previewUrl, or artifactUrl)');
    }

    let fullUrl = `${baseUrl}/${launchFile}`;

    // Security: validate against allowed domains
    this.validateUrlDomain(fullUrl);

    // CORS: proxy through portal if cross-origin
    fullUrl = this.proxyIfCrossOrigin(fullUrl);

    return this.sanitizer.bypassSecurityTrustResourceUrl(fullUrl);
  }


  // -------------------------------------------------------------------
  // Validate the content URL against the allowed domain list
  // -------------------------------------------------------------------
  // Reads from window.__scormAllowedDomains (injected by EJS).
  // Falls back to allowing only localhost (safe default for dev).
  // -------------------------------------------------------------------

  private validateUrlDomain(url: string): void {
    const allowedRaw: string = (window as any).__scormAllowedDomains || '';
    const allowedDomains = allowedRaw
      .split(',')
      .map(d => d.trim().toLowerCase())
      .filter(d => d.length > 0);

    // Safe default: only localhost if nothing configured
    if (allowedDomains.length === 0) {
      allowedDomains.push('localhost');
    }

    try {
      const hostname = new URL(url).hostname.toLowerCase();
      const isAllowed = allowedDomains.some(domain =>
        hostname === domain || hostname.endsWith('.' + domain)
      );
      if (!isAllowed) {
        throw new Error(`Content domain "${hostname}" not in allowed list: [${allowedDomains.join(', ')}]`);
      }
    } catch (e) {
      // Re-throw domain validation errors
      if (e.message.includes('not in allowed list')) throw e;
      // URL parsing failed — likely a relative URL, which is same-origin (fine)
    }
  }


  // -------------------------------------------------------------------
  // Rewrite cross-origin URLs through the portal's /content-storage proxy
  // -------------------------------------------------------------------
  // In production behind a CDN where everything is same-origin,
  // no rewrite happens. Locally with MinIO on :9001, it kicks in.
  // -------------------------------------------------------------------

  private proxyIfCrossOrigin(url: string): string {
    try {
      const contentOrigin = new URL(url).origin;
      const portalOrigin  = window.location.origin;

      if (contentOrigin !== portalOrigin) {
        return url.replace(contentOrigin, '/content-storage');
      }
    } catch (_) {
      // Relative URL — already same-origin, no rewrite needed
    }
    return url;
  }


  // -------------------------------------------------------------------
  // Event emitters — match the shape other players emit
  // -------------------------------------------------------------------

  private emitPlayer(type: string, data?: any): void {
    this.playerEvent.emit({ eid: type, metaData: data || {} });
  }

  private emitTelemetry(eid: string): void {
    this.telemetryEvent.emit({
      detail: {
        telemetryData: {
          eid,
          ets: Date.now(),
          ver: '3.0',
          mid: `SCORM:${eid}:${Date.now()}`,
          actor: {
            id: this.sessionConfig?.userId || 'anonymous',
            type: 'User'
          },
          context: this.playerConfig?.context,
          object: {
            id: this.sessionConfig?.contentId,
            type: 'Content',
            ver: String(this.playerConfig?.metadata?.pkgVersion || '1.0')
          },
          edata: { type: 'scorm', mode: 'play' }
        }
      }
    });
  }


  // -------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------

  ngOnDestroy(): void {
    this.scormService.destroy();
  }
}
