export class Sentence extends Error {}
export type Operation = 'load' | 'save' | 'action';
export const LOAD_FAILED: string;
export const sessionGuards: Set<string>;
export const raisedText: Record<string, string>;
export const raisedPatterns: [RegExp, string][];
export const personSentences: RegExp;
export const constraintText: Record<string, string>;
export function needsSessionCheck(error: unknown): boolean;
export function errorMessage(error: unknown, operation?: Operation, signedIn?: boolean): string;
