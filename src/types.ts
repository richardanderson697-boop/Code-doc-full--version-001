export interface VibeProject {
  id: string;
  title: string;
  prompt: string;
  code: string;
  purpose: string;
  createdAt: string;
  updatedAt: string;
}

export interface SplitContent {
  purpose: string;
  code: string;
}
