interface AutoPipSettings {
  enabled: boolean;
  disabledOrigins: string[];
}

interface AutoPipResult {
  ok: boolean;
  message: string;
}

interface AutoPipStatus {
  version: string;
  supported: boolean;
  automaticSupported: boolean;
  automaticMode: 'document' | 'video';
  enabled: boolean;
  videoCount: number;
  playingCount: number;
  candidateScore: number;
  inPictureInPicture: boolean;
  lastError: string;
}

interface Window {
  documentPictureInPicture?: {
    readonly window: Window | null;
    requestWindow?(options?: { width?: number; height?: number }): Promise<Window>;
  };
  __chromeAutoPipV1?: {
    configure(enabled: boolean): void;
    getStatus(): AutoPipStatus;
    onTabActivated(closeNow?: boolean): Promise<void>;
    open(): Promise<AutoPipResult>;
    close(): Promise<AutoPipResult>;
    toggle(): Promise<AutoPipResult>;
  };
}

interface AutoPipFrameState {
  video: boolean;
  documentWindow: boolean;
  errors: string[];
}

interface AutoPipFrameClose {
  observed: boolean;
  remaining: boolean;
  errors: string[];
}

interface AutoPipCloseReport extends AutoPipResult, AutoPipFrameClose {
  checkedFrames: number;
  frames: AutoPipFrameCloseReport[];
}

interface AutoPipFrameCloseReport extends AutoPipFrameClose {
  frameId: number;
  verified: boolean;
  ok: boolean;
  documentIds: string[];
  world: 'MAIN';
}

interface AutoPipFrameOwner {
  frameId: number;
  documentId?: string;
}

interface AutoPipGlobalCloseReport extends AutoPipResult {
  scannedTabs: number;
  owningTabIds: number[];
  reports: Array<AutoPipCloseReport & { tabId: number }>;
  errors: string[];
}
