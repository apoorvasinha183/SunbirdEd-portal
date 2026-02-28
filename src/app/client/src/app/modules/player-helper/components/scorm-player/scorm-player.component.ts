import { Component, Input, Output, EventEmitter, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { Scorm12API, Scorm2004API } from 'scorm-again';

@Component({
  selector: 'app-scorm-player',
  templateUrl: './scorm-player.component.html',
  styleUrls: ['./scorm-player.component.scss']
})
export class ScormPlayerComponent implements OnInit, OnDestroy {
  @Input() playerConfig: any;
  @Output() playerEvent = new EventEmitter<any>();
  @Output() telemetryEvent = new EventEmitter<any>();

  @ViewChild('scormIframe') scormIframe: ElementRef;

  scormApi: any;
  contentUrl: SafeResourceUrl;
  loading = true;
  error: string;

  constructor(private sanitizer: DomSanitizer) { }

  ngOnInit() {
    this.initializeScormPlayer();
  }

  async initializeScormPlayer() {
    try {
      const contentId = this.playerConfig.metadata.identifier;
      const userId = this.playerConfig.context.uid || 'anonymous';

      console.log('SCORM Player: Initializing', { contentId, userId });
      console.log('SCORM Player: PlayerConfig', this.playerConfig);

      const scormVersion = this.playerConfig.metadata.scormVersion || '1.2';
      console.log('SCORM Player: Detected version', scormVersion);

      // STEP 1: Initialize scorm-again API FIRST
      const apiConfig = {
        lmsCommitUrl: `/api/scorm/v1/commit`,
        dataCommitFormat: 'json',
        autocommit: true,
        autocommitSeconds: 30,
        logLevel: 4  // Debug level
      };

      if (scormVersion.includes('2004')) {
        console.log('SCORM Player: Creating Scorm2004API instance');
        this.scormApi = new Scorm2004API(apiConfig);
        // STEP 2: Expose API to window IMMEDIATELY (before iframe loads)
        (window as any).API_1484_11 = this.scormApi;
        console.log('SCORM Player: API exposed to window.API_1484_11');
      } else {
        console.log('SCORM Player: Creating Scorm12API instance');
        this.scormApi = new Scorm12API(apiConfig);
        // STEP 2: Expose API to window IMMEDIATELY (before iframe loads)
        (window as any).API = this.scormApi;
        console.log('SCORM Player: API exposed to window.API');
      }

      console.log('SCORM Player: API object:', this.scormApi);

      // STEP 3: Load existing SCORM data
      const response = await fetch(`/api/scorm/v1/data/${contentId}?userId=${userId}`);
      const result = await response.json();

      if (result.success && result.data && Object.keys(result.data).length > 0) {
        console.log('SCORM Player: Loading saved data', result.data);
        this.scormApi.loadFromJSON(result.data);
      } else {
        console.log('SCORM Player: No saved data found, starting fresh');
      }

      // STEP 4: Set up event listeners
      this.scormApi.on('LMSInitialize', () => {
        console.log('SCORM: LMSInitialize called');
        this.emitTelemetry('START');
      });

      this.scormApi.on('LMSFinish', () => {
        console.log('SCORM: LMSFinish called');
        this.emitTelemetry('END');
      });

      this.scormApi.on('LMSCommit', (data: any) => {
        console.log('SCORM: LMSCommit called', data);
        this.saveScormData(data);
      });

      // STEP 5: Construct SCORM content URL (this triggers iframe load)
      const streamingUrl = this.playerConfig.metadata.streamingUrl;
      const previewUrl = this.playerConfig.metadata.previewUrl;
      const artifactUrl = this.playerConfig.metadata.artifactUrl;
      const scormLaunchUrl = this.playerConfig.metadata.scormLaunchUrl || 'index_lms.html';

      // Priority: streamingUrl > previewUrl > artifactUrl
      let baseUrl = streamingUrl || previewUrl;

      if (!baseUrl && artifactUrl) {
        // Extract base path from artifactUrl
        const lastSlash = artifactUrl.lastIndexOf('/');
        baseUrl = artifactUrl.substring(0, lastSlash);
      }

      if (!baseUrl) {
        throw new Error('No content URL available (streamingUrl, previewUrl, or artifactUrl)');
      }

      // Construct full URL with launch file and sanitize
      let fullUrl = `${baseUrl}/${scormLaunchUrl}`;

      // Fix for cross-origin iframe issues (CORS) when running locally
      // Proxy requests to 9001 through the 3000 portal backend
      if (fullUrl.includes('localhost:9001')) {
        fullUrl = fullUrl.replace('http://localhost:9001', '/content-storage');
      }

      this.contentUrl = this.sanitizer.bypassSecurityTrustResourceUrl(fullUrl);

      console.log('SCORM Player: Content URL', fullUrl);
      console.log('SCORM Player: API is ready at window.API - iframe will now load');

      this.loading = false;
      this.emitTelemetry('START');

      console.log('SCORM Player: Initialization complete');
      console.log('SCORM Player: Iframe should find API at window.parent.API or window.top.API');

    } catch (error) {
      console.error('SCORM Player Initialization Error:', error);
      this.error = error.message;
      this.loading = false;
    }
  }

  async saveScormData(cmiData: any) {
    try {
      const contentId = this.playerConfig.metadata.identifier;
      const userId = this.playerConfig.context.uid || 'anonymous';

      console.log('SCORM Player: Saving data', { contentId, userId, dataSize: JSON.stringify(cmiData).length });

      const response = await fetch('/api/scorm/v1/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contentId, userId, cmiData })
      });

      const result = await response.json();
      console.log('SCORM Player: Data saved', result);

    } catch (error) {
      console.error('SCORM Player: Error saving data', error);
    }
  }

  emitTelemetry(eid: string) {
    const event = {
      eid,
      ets: Date.now(),
      ver: '3.0',
      mid: `${eid}:${Date.now()}`,
      actor: {
        id: this.playerConfig.context.uid || 'anonymous',
        type: 'User'
      },
      context: this.playerConfig.context,
      object: {
        id: this.playerConfig.metadata.identifier,
        type: 'Content',
        ver: this.playerConfig.metadata.pkgVersion || '1.0'
      },
      edata: {
        type: 'scorm',
        mode: 'play'
      }
    };

    console.log('SCORM Player: Emitting telemetry', eid);
    this.telemetryEvent.emit({ detail: { telemetryData: event } });
  }

  ngOnDestroy() {
    console.log('SCORM Player: Destroying');

    if (this.scormApi) {
      try {
        // Call LMSFinish to properly terminate the SCORM session
        this.scormApi.LMSFinish();
      } catch (e) {
        console.error('Error terminating SCORM session:', e);
      }
    }

    // Clean up window.API
    if ((window as any).API) {
      delete (window as any).API;
    }

    this.emitTelemetry('END');
  }
}
