import { sweepOrphansGlobalSetup } from '@xitter/testing';

// vitest resolves globalSetup as a file path, not an inline hook (#47).
export default sweepOrphansGlobalSetup;
