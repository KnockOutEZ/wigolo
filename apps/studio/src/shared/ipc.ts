export interface TabInfo {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

export interface StudioState {
  sessionName: string;
  tabs: TabInfo[];
}

// renderer → main
export const IPC = {
  tabCreate: 'studio:tab-create',
  tabClose: 'studio:tab-close',
  tabFocus: 'studio:tab-focus',
  tabNavigate: 'studio:tab-navigate',
  getState: 'studio:get-state',
  // main → renderer
  stateChanged: 'studio:state-changed',
} as const;
