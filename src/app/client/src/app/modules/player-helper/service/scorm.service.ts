// scorm.service.ts
// Purpose: Manages the scorm-again runtime API lifecycle.
//
// This service does NOT own persistence. It intercepts SCORM commit events
// and calls the SAME content-state-update API that every other player uses.
// The only difference: SCORM adds a `progressdetails` field containing
// the CMI data snapshot, which Lern BB stores as freeform JSON in Cassandra.
//
// Principle: each public method does exactly one thing.

import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { Scorm12API, Scorm2004API } from 'scorm-again';

// -----------------------------------------------------------------------
// Interfaces — one per concern
// -----------------------------------------------------------------------

/** Everything needed to identify a SCORM session */
export interface ScormSessionConfig {
  contentId: string;       // Sunbird content identifier (do_xxxxx)
  userId: string;          // Logged-in user ID or 'anonymous'
  courseId?: string;        // Parent course ID (if enrolled in a course)
  batchId?: string;         // Course batch ID (if enrolled)
  scormVersion: '1.2' | '2004';
}

/** Raw SCORM CMI key-value data from scorm-again */
export interface ScormCmiData {
  [key: string]: string;
}

// -----------------------------------------------------------------------
// URL config — matches url.config.json
// -----------------------------------------------------------------------
// These are the same endpoints used by courseProgressService.
// We call them directly because:
//   1. SCORM commits happen every ~30s (not just on START/END)
//   2. We need to include `progressdetails` (other players don't)
//   3. The event-based flow only fires for START and END
// -----------------------------------------------------------------------

const CONTENT_STATE_UPDATE = 'course/v1/content/state/update';
const CONTENT_STATE_READ   = 'course/v1/content/state/read';

// -----------------------------------------------------------------------
// Service
// -----------------------------------------------------------------------

@Injectable({ providedIn: 'root' })
export class ScormService {

  // The active scorm-again API instance (Scorm12API or Scorm2004API)
  private scormApi: any = null;

  // Which version is active (needed for cleanup and event names)
  private activeVersion: '1.2' | '2004' | null = null;

  // Session config for the current content
  private config: ScormSessionConfig | null = null;

  constructor(private http: HttpClient) {}


  // ===== Method 1: Create the SCORM API on window =======================
  //
  // SCORM packages inside the iframe search up the window chain:
  //   iframe.parent → iframe.parent.parent → ... → top
  // looking for window.API (SCORM 1.2) or window.API_1484_11 (SCORM 2004).
  //
  // We attach it BEFORE the iframe loads so the package finds it.
  //
  // Key config: autocommit is OFF. We don't use lmsCommitUrl (that would
  // require a custom backend endpoint). Instead, we listen for commit
  // events and call the existing content-state-update API ourselves.
  // ======================================================================

  initializeApi(config: ScormSessionConfig): void {
    this.config = config;

    // No lmsCommitUrl — we handle persistence via event listeners
    const apiConfig = {
      autocommit: false,
      logLevel: 1   // 1 = errors only. Use 4 for local debugging.
    };

    if (config.scormVersion === '2004') {
      this.scormApi = new Scorm2004API(apiConfig);
      (window as any).API_1484_11 = this.scormApi;
    } else {
      this.scormApi = new Scorm12API(apiConfig);
      (window as any).API = this.scormApi;
    }

    this.activeVersion = config.scormVersion;
  }


  // ===== Method 2: Restore CMI data from Lern BB ========================
  //
  // Calls the existing content-state-read API. If the response contains
  // progressdetails.scormData, loads it into the scorm-again instance
  // so the learner resumes where they left off.
  //
  // Call AFTER initializeApi() but BEFORE the iframe loads.
  // ======================================================================

  async restoreCmiData(): Promise<void> {
    if (!this.scormApi || !this.config) {
      throw new Error('Call initializeApi() before restoreCmiData()');
    }

    try {
      const response: any = await firstValueFrom(
        this.http.post(CONTENT_STATE_READ, {
          request: {
            userId: this.config.userId,
            courseId: this.config.courseId || this.config.contentId,
            batchId: this.config.batchId || 'default',
            contentIds: [this.config.contentId],
            fields: ['progressdetails', 'status']
          }
        })
      );

      // Extract CMI data from the response
      const contentState = response?.result?.contentList?.[0];
      const savedCmi = contentState?.progressdetails?.scormData;

      // Load saved data into scorm-again if we have any
      if (savedCmi && Object.keys(savedCmi).length > 0) {
        this.scormApi.loadFromJSON(savedCmi);
      }
    } catch (error) {
      // Non-fatal: learner starts fresh if restore fails.
      // This also handles the case where Lern BB isn't running locally.
      console.warn('Could not restore SCORM progress (non-fatal):', error?.message || error);
    }
  }


  // ===== Method 3: Register commit handler ==============================
  //
  // Intercepts scorm-again's LMSCommit / Commit event and persists
  // the CMI snapshot to Lern BB via the existing content-state-update API.
  //
  // The `progressdetails` field is freeform JSON that Lern BB stores
  // in Cassandra without inspecting it. This is the same field available
  // to ALL content types — SCORM is just the first to use it.
  //
  // Also accepts optional callbacks so the component can emit
  // telemetry or UI events without the service knowing about Angular.
  // ======================================================================

  registerCommitHandler(callbacks?: {
    onInitialize?: () => void;
    onCommit?: () => void;
    onFinish?: () => void;
  }): void {
    if (!this.scormApi || !this.config) {
      throw new Error('Call initializeApi() first');
    }

    // Wire up lifecycle callbacks
    if (callbacks?.onInitialize) {
      this.scormApi.on('LMSInitialize', callbacks.onInitialize);
    }
    if (callbacks?.onFinish) {
      this.scormApi.on('LMSFinish', callbacks.onFinish);
    }

    // The main event: intercept commits and persist CMI data
    this.scormApi.on('LMSCommit', () => {
      this.persistCmiData();
      if (callbacks?.onCommit) {
        callbacks.onCommit();
      }
    });
  }


  // ===== Method 4: Persist CMI data (private) ===========================
  //
  // Calls the SAME content/state/update endpoint that every player uses.
  // The only addition is the `progressdetails` field containing the CMI
  // data snapshot. Fire-and-forget — a failed commit doesn't break the
  // learner's current session.
  // ======================================================================

  private persistCmiData(): void {
    if (!this.scormApi || !this.config) {
      return;
    }

    // Extract all CMI data from scorm-again
    const cmiData = this.scormApi.renderCommitCMI(true);

    const payload = {
      request: {
        userId: this.config.userId,
        contents: [{
          contentId: this.config.contentId,
          courseId: this.config.courseId || this.config.contentId,
          batchId: this.config.batchId || 'default',
          status: this.mapCompletionStatus(cmiData),
          lastAccessTime: new Date().toISOString(),
          progressdetails: {
            scormData: cmiData,
            lastUpdated: new Date().toISOString()
          }
        }]
      }
    };

    // Fire-and-forget. Log errors but don't break the session.
    this.http.patch(CONTENT_STATE_UPDATE, payload).subscribe({
      error: (err) => console.warn('SCORM CMI persist failed (non-fatal):', err?.message || err)
    });
  }


  // ===== Method 5: Terminate and clean up ===============================
  //
  // One final persist, then remove the API from window so the next
  // content load starts clean.
  // ======================================================================

  destroy(): void {
    if (this.scormApi) {
      // Final persist before teardown
      this.persistCmiData();

      try {
        this.activeVersion === '2004'
          ? this.scormApi.Terminate('')
          : this.scormApi.LMSFinish('');
      } catch (_) {
        // Session may already be terminated by the SCORM package itself
      }
    }

    // Clean window references
    if (this.activeVersion === '2004') {
      delete (window as any).API_1484_11;
    } else {
      delete (window as any).API;
    }

    this.scormApi = null;
    this.activeVersion = null;
    this.config = null;
  }


  // ===== Helper: Map SCORM status → Sunbird status code =================
  //
  // Sunbird codes:  1 = in progress,  2 = completed
  // SCORM 1.2:      cmi.core.lesson_status
  // SCORM 2004:     cmi.completion_status
  // ======================================================================

  private mapCompletionStatus(cmiData: ScormCmiData): number {
    const status = (
      cmiData?.['cmi.core.lesson_status'] ||
      cmiData?.['cmi.completion_status'] ||
      ''
    ).toLowerCase();

    if (['completed', 'passed'].includes(status)) {
      return 2;
    }

    // Default: in-progress (we know they opened it)
    return 1;
  }
}
