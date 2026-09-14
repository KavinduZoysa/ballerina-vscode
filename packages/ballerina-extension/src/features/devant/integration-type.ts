/**
 * Copyright (c) 2026, WSO2 LLC. (https://www.wso2.com) All Rights Reserved.
 *
 * WSO2 LLC. licenses this file to you under the Apache License,
 * Version 2.0 (the "License"); you may not use this file except
 * in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { AUTOMATION_WITH_LISTENER_WARNING, resolveIntegrationType } from "@wso2/wso2-platform-core";
import { window } from "vscode";

const DEFAULT_PLACE_HOLDER =
    "You have multiple artifact types within this project. Select the artifact type to be deployed";

/**
 * Picks the integration type to deploy from the scopes a package offers, prompting only when
 * {@link resolveIntegrationType} cannot settle on one. Returns undefined when there is nothing to
 * deploy or the user dismissed the prompt, so callers can bail out without dispatching.
 *
 * Generic over the scope enum because `SCOPE` (ballerina-core) and `DevantScopes`
 * (wso2-platform-core) carry identical string values and both reach this from a deploy entry point.
 */
export async function selectIntegrationType<T extends string>(
    integrationTypes: T[],
    placeHolder: string = DEFAULT_PLACE_HOLDER,
): Promise<T | undefined> {
    if (!integrationTypes?.length) {
        return undefined;
    }

    const resolution = resolveIntegrationType(integrationTypes);

    if (resolution.kind === "autoPick") {
        return resolution.scope as T;
    }

    if (resolution.kind === "autoPickWithWarning") {
        const choice = await window.showWarningMessage(
            AUTOMATION_WITH_LISTENER_WARNING,
            { modal: true },
            "Continue",
        );
        if (choice !== "Continue") {
            return undefined;
        }
        return resolution.scope as T;
    }

    const selectedScope = await window.showQuickPick(resolution.choices, { placeHolder });
    return selectedScope as T | undefined;
}
