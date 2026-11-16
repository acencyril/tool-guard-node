export type Verdict = 'allow' | 'deny' | 'pending';
export declare class Decision {
  readonly verdict: Verdict;
  readonly reason: string | null;
  readonly approvalId: string | null;
  readonly allowed: boolean;
  readonly held: boolean;
  messageForModel(): string;
}
export declare class ToolCallBlocked extends Error {
  readonly decision: Decision;
  readonly tool: string;
  readonly held: boolean;
}

export declare const APPROVAL: 'approval';
export declare const DENY: 'deny';
export declare const PER_USER: 'user';
export declare const PER_TOOL: 'tool';
export declare const ENFORCE: 'enforce';
export declare const OBSERVE: 'observe';
export declare const AI: 'ai';
export declare const CODE: 'code';

export type Rule =
  | { kind: 'granted'; permission: string; subject: string | null; message: string | null }
  | { kind: 'limit'; argument: string; max: number; above: 'deny' | 'approval'; min: number | null }
  | { kind: 'values'; argument: string; patterns: string[]; otherwise: 'deny' | 'approval' }
  | { kind: 'rate'; limit: number; seconds: number; per: 'user' | 'tool' }
  | { kind: 'approval'; reason: string | null };

export declare function granted(permission: string, options?: { subject?: string; message?: string }): Rule;
export declare function limit(argument: string, options: { max: number; above?: 'deny' | 'approval'; min?: number }): Rule;
export declare function allowedValues(argument: string, patterns: string[], options?: { otherwise?: 'deny' | 'approval' }): Rule;
export declare function rateLimit(limit: number, options: { perSeconds: number; per?: 'user' | 'tool' }): Rule;
export declare function requiresApproval(reason?: string): Rule;

export interface Approval {
  id: string;
  tool: string;
  arguments: Record<string, unknown>;
  requestedBy: string | null;
  reason: string;
  requestedAt: string;
  channel: string;
  agent: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'failed';
  decidedBy: string | null;
  decidedAt: string | null;
  result: string | null;
}
export interface ApprovalStore { save(a: Approval): void; get(id: string): Approval | null; all(status?: string | null): Approval[] }
export interface Journal { record(entry: Record<string, unknown>): void; tail(n?: number): Record<string, unknown>[] }
export interface StopEntry { scope: 'all' | 'agents' | 'tool' | 'agent'; target: string | null; by: string | null; reason: string | null; at: string }
export interface StopStore { all(): StopEntry[]; stop(s: StopEntry): void; resume(scope: string, target?: string | null): boolean }
export interface Counter { consume(key: string, limit: number, seconds: number, at?: number): boolean }

export declare class MemoryApprovals implements ApprovalStore { save(a: Approval): void; get(id: string): Approval | null; all(status?: string | null): Approval[] }
export declare class FileApprovals implements ApprovalStore { constructor(dir: string); save(a: Approval): void; get(id: string): Approval | null; all(status?: string | null): Approval[] }
export declare class MemoryJournal implements Journal { entries: Record<string, unknown>[]; record(e: Record<string, unknown>): void; tail(n?: number): Record<string, unknown>[] }
export declare class FileJournal implements Journal { constructor(file: string); record(e: Record<string, unknown>): void; tail(n?: number): Record<string, unknown>[] }
export declare class MemoryStops implements StopStore { all(): StopEntry[]; stop(s: StopEntry): void; resume(scope: string, target?: string | null): boolean }
export declare class FileStops implements StopStore { constructor(file: string); all(): StopEntry[]; stop(s: StopEntry): void; resume(scope: string, target?: string | null): boolean }
export declare class MemoryCounter implements Counter { consume(key: string, limit: number, seconds: number, at?: number): boolean }
export declare class FileCounter implements Counter { constructor(file: string); consume(key: string, limit: number, seconds: number, at?: number): boolean }

export interface GuardOptions {
  approvals?: ApprovalStore;
  journal?: Journal;
  stops?: StopStore | null;
  counter?: Counter;
  isGranted?: ((permission: string, subject: unknown, user: string | null) => boolean | Promise<boolean>) | null;
  currentUser?: (() => string | null | Promise<string | null>) | null;
  mode?: 'enforce' | 'observe';
  maxPendingPerUser?: number;
  expireAfter?: number | null;
  agents?: Record<string, string[]> | null;
  allowUnknownAgent?: boolean;
  fourEyes?: boolean;
}

export declare class Guard {
  constructor(options?: GuardOptions);
  approvals: ApprovalStore;
  journal: Journal;
  wrap<A extends Record<string, unknown>, R, Rest extends unknown[]>(
    name: string,
    rules: Rule[],
    fn: (args: A, ...rest: Rest) => R | Promise<R>,
    options?: { throwBlocked?: boolean; user?: string | ((args: A, ...rest: Rest) => string | null | Promise<string | null>) | null; agent?: string | ((args: A, ...rest: Rest) => string | null) | null },
  ): (args: A, ...rest: Rest) => Promise<R | string>;
  call<R = unknown>(name: string, args: Record<string, unknown>, options?: { user?: string | null; agent?: string | null; channel?: 'ai' | 'code' }): Promise<R>;
  decide(tool: string, args: Record<string, unknown>, options?: { user?: string | null; agent?: string | null; channel?: 'ai' | 'code' }): Promise<Decision>;
  approve(id: string, by: string): Promise<Approval>;
  reject(id: string, by: string): Approval;
  stop(scope?: 'all' | 'agents' | 'tool' | 'agent', target?: string | null, options?: { by?: string | null; reason?: string | null }): void;
  resume(scope?: 'all' | 'agents' | 'tool' | 'agent', target?: string | null, options?: { by?: string | null }): boolean;
  rules(): Record<string, string[]>;
}
