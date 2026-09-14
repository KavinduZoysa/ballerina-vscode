/**
 * @jest-environment node
 *
 * Covers the scope-to-deploy-target resolution shared by the three cloud deploy entry points.
 * The classification itself lives in `resolveIntegrationType` in @wso2/wso2-platform-core; these
 * assert the prompting behaviour the extension wraps around it.
 */

import { DevantScopes } from '@wso2/wso2-platform-core';
import { window } from 'vscode';
import { selectIntegrationType } from '../features/devant/integration-type';

const originalShowQuickPick = window.showQuickPick;
const originalShowWarningMessage = window.showWarningMessage;

let quickPickCalls: string[][];
let warningCalls: string[];

beforeEach(() => {
    quickPickCalls = [];
    warningCalls = [];
    window.showQuickPick = ((items: readonly string[]) => {
        quickPickCalls.push([...items]);
        return Promise.resolve(undefined);
    }) as typeof window.showQuickPick;
    window.showWarningMessage = ((message: string) => {
        warningCalls.push(message);
        return Promise.resolve(undefined);
    }) as typeof window.showWarningMessage;
});

afterEach(() => {
    window.showQuickPick = originalShowQuickPick;
    window.showWarningMessage = originalShowWarningMessage;
});

describe('selectIntegrationType', () => {
    it.each([
        ['no scopes', [] as DevantScopes[]],
        ['an undefined scope list', undefined as unknown as DevantScopes[]],
    ])('returns undefined for %s without prompting', async (_case, scopes) => {
        await expect(selectIntegrationType(scopes)).resolves.toBeUndefined();
        expect(quickPickCalls).toHaveLength(0);
    });

    it.each([
        ['a workflow', DevantScopes.WORKFLOW],
        ['an automation', DevantScopes.AUTOMATION],
        ['an API integration', DevantScopes.INTEGRATION_AS_API],
    ])('auto-picks %s when it is the only scope', async (_case, scope) => {
        await expect(selectIntegrationType([scope])).resolves.toBe(scope);
        expect(quickPickCalls).toHaveLength(0);
    });

    // A workflow classifies as a service scope, so a listener alongside it is passive and the
    // workflow is picked without asking. This is what DevantScopes.WORKFLOW joining SERVICE_SCOPES
    // buys — before that, an unclassified scope forced the prompt every time.
    it.each([
        ['an event listener', DevantScopes.EVENT_INTEGRATION],
        ['a file listener', DevantScopes.FILE_INTEGRATION],
    ])('auto-picks a workflow accompanied by %s', async (_case, listener) => {
        await expect(selectIntegrationType([DevantScopes.WORKFLOW, listener])).resolves.toBe(
            DevantScopes.WORKFLOW,
        );
        expect(quickPickCalls).toHaveLength(0);
    });

    it('prompts when a workflow and an API integration are both present', async () => {
        window.showQuickPick = (() => Promise.resolve(DevantScopes.WORKFLOW)) as typeof window.showQuickPick;

        await expect(
            selectIntegrationType([DevantScopes.INTEGRATION_AS_API, DevantScopes.WORKFLOW]),
        ).resolves.toBe(DevantScopes.WORKFLOW);
    });

    it('offers every scope present when it has to ask', async () => {
        await selectIntegrationType([DevantScopes.INTEGRATION_AS_API, DevantScopes.WORKFLOW]);

        expect(quickPickCalls).toEqual([[DevantScopes.INTEGRATION_AS_API, DevantScopes.WORKFLOW]]);
    });

    it('returns undefined when the user dismisses the prompt', async () => {
        await expect(
            selectIntegrationType([DevantScopes.INTEGRATION_AS_API, DevantScopes.WORKFLOW]),
        ).resolves.toBeUndefined();
    });

    it('warns before picking an automation that runs alongside a listener', async () => {
        window.showWarningMessage = ((message: string) => {
            warningCalls.push(message);
            return Promise.resolve('Continue');
        }) as typeof window.showWarningMessage;

        await expect(
            selectIntegrationType([DevantScopes.AUTOMATION, DevantScopes.EVENT_INTEGRATION]),
        ).resolves.toBe(DevantScopes.AUTOMATION);
        expect(warningCalls).toHaveLength(1);
    });

    it('returns undefined when the automation-with-listener warning is dismissed', async () => {
        await expect(
            selectIntegrationType([DevantScopes.AUTOMATION, DevantScopes.EVENT_INTEGRATION]),
        ).resolves.toBeUndefined();
        expect(warningCalls).toHaveLength(1);
    });
});
