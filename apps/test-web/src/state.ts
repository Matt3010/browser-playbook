export interface WizardSubmission {
  name: string;
  email: string;
  plan: string;
  newsletter: boolean;
  notes: string;
  submittedAt: string;
}

export interface TestConfig {
  /** Delay in ms before the dashboard's late element appears. */
  dashboardDelayMs: number;
  /** Delay in ms before the /errors delayed button appears. */
  delayedButtonMs: number;
  /** When true the "Conferma" button on /errors is not rendered at all. */
  missingElement: boolean;
  /** When true /api/flaky returns HTTP 500. */
  failApi: boolean;
  /** When true the login form always reports wrong credentials. */
  rejectLogin: boolean;
}

export interface TestState {
  config: TestConfig;
  wizardSubmissions: WizardSubmission[];
  uploads: Array<{ filename: string; size: number; content: string }>;
  loginAttempts: number;
  /** Partial wizard data between step 1 and step 2, keyed by session id. */
  wizardDrafts: Record<string, { name: string; email: string }>;
}

export const DEFAULT_CONFIG: TestConfig = {
  dashboardDelayMs: 300,
  delayedButtonMs: 500,
  missingElement: false,
  failApi: false,
  rejectLogin: false
};

function freshState(): TestState {
  return {
    config: { ...DEFAULT_CONFIG },
    wizardSubmissions: [],
    uploads: [],
    loginAttempts: 0,
    wizardDrafts: {}
  };
}

let state: TestState = freshState();

export function getState(): TestState {
  return state;
}

export function resetState(): void {
  state = freshState();
}

export function configure(patch: Partial<TestConfig>): TestConfig {
  state.config = { ...state.config, ...patch };
  return state.config;
}

export const VALID_EMAIL = "test@example.com";
export const VALID_PASSWORD = "TestPassword123!";
