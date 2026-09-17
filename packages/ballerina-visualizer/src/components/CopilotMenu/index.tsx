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

import React, { useEffect, useRef, useState } from "react";
import styled from "@emotion/styled";
import { AIPanelView, ThreadSummary } from "@wso2/ballerina-core";
import { useRpcContext } from "@wso2/ballerina-rpc-client";
import { openCopilotPanelAt, openCopilotThread } from "../AgentStatusOrb/copilotPanel";

const RECENT_THREAD_LIMIT = 5;

/** A surface the menu can jump to. Adding one here is the whole change. */
interface SurfaceEntry {
    id: AIPanelView;
    label: string;
    icon: string;
}

const SURFACES: SurfaceEntry[] = [{ id: "settings", label: "Settings", icon: "settings-gear" }];

type MenuLevel = "root" | "chats";

const Root = styled.div`
    position: relative;
    display: flex;
`;

const TriggerButton = styled.button`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background-color: transparent;
    color: var(--vscode-icon-foreground);
    cursor: pointer;
    font-size: 16px;
    transition: background-color 0.2s;

    &:hover,
    &:focus-visible {
        background-color: var(--vscode-toolbar-hoverBackground);
    }
`;

const Surface = styled.div`
    position: absolute;
    bottom: calc(100% + 6px);
    left: 0;
    z-index: 10;
    // Hugs its items; the cap only bites on long thread names, which then ellipsize.
    width: max-content;
    min-width: 132px;
    max-width: 260px;
    padding: 4px;
    border: 1px solid var(--vscode-editorWidget-border, var(--vscode-panel-border));
    border-radius: 6px;
    background-color: var(--vscode-editorWidget-background);
    box-shadow: 0 4px 14px var(--vscode-widget-shadow, transparent);
`;

const Row = styled.button`
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: 12px;
    text-align: left;
    cursor: pointer;

    &:hover,
    &:focus-visible {
        background-color: var(--vscode-list-hoverBackground);
    }
`;

const RowLabel = styled.span`
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const Note = styled.div`
    padding: 6px 8px;
    color: var(--vscode-descriptionForeground);
    font-size: 12px;
`;

/**
 * Entry points into the Copilot panel, kept out of the surfaces that host it so the overview,
 * the mini chat and anything later can share one menu.
 */
export function CopilotMenu({ icon = "settings" }: { icon?: string } = {}) {
    const { rpcClient } = useRpcContext();
    const [open, setOpen] = useState(false);
    const [level, setLevel] = useState<MenuLevel>("root");
    const [threads, setThreads] = useState<ThreadSummary[] | undefined>(undefined);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: PointerEvent) => {
            if (!rootRef.current?.contains(event.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setOpen(false);
            }
        };
        document.addEventListener("pointerdown", onPointerDown);
        document.addEventListener("keydown", onKeyDown);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown);
            document.removeEventListener("keydown", onKeyDown);
        };
    }, [open]);

    // Loaded on open rather than on mount: the list is only ever seen from inside the menu.
    useEffect(() => {
        if (!open || !rpcClient || threads !== undefined) {
            return;
        }
        let cancelled = false;
        rpcClient
            .getAiPanelRpcClient()
            .listThreads()
            .then((list) => !cancelled && setThreads(list))
            .catch(() => !cancelled && setThreads([]));
        return () => {
            cancelled = true;
        };
    }, [open, rpcClient, threads]);

    const toggle = () => {
        setLevel("root");
        setOpen((wasOpen) => !wasOpen);
    };

    const recent = (threads ?? []).slice(0, RECENT_THREAD_LIMIT);

    return (
        <Root ref={rootRef}>
            <TriggerButton
                type="button"
                data-testid={`copilot-menu-trigger-${icon}`}
                title="WSO2 Integrator Copilot"
                aria-label="WSO2 Integrator Copilot"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
            >
                <span className={`codicon codicon-${icon}`} />
            </TriggerButton>

            {open && (
                <Surface role="menu" data-testid="copilot-menu">
                    {level === "root" ? (
                        <>
                            <Row type="button" role="menuitem" onClick={() => setLevel("chats")}>
                                <span className="codicon codicon-comment-discussion" />
                                <RowLabel>Chats</RowLabel>
                                <span className="codicon codicon-chevron-right" />
                            </Row>
                            {SURFACES.map((surface) => (
                                <Row
                                    key={surface.id}
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                        setOpen(false);
                                        openCopilotPanelAt(rpcClient, surface.id);
                                    }}
                                >
                                    <span className={`codicon codicon-${surface.icon}`} />
                                    <RowLabel>{surface.label}</RowLabel>
                                </Row>
                            ))}
                        </>
                    ) : (
                        <>
                            <Row type="button" role="menuitem" onClick={() => setLevel("root")}>
                                <span className="codicon codicon-arrow-left" />
                                <RowLabel>Chats</RowLabel>
                            </Row>
                            {threads === undefined && <Note>Loading…</Note>}
                            {threads?.length === 0 && <Note>No chats yet</Note>}
                            {recent.map((thread) => (
                                <Row
                                    key={thread.id}
                                    type="button"
                                    role="menuitem"
                                    title={thread.name}
                                    onClick={() => {
                                        setOpen(false);
                                        openCopilotThread(rpcClient, thread.id);
                                    }}
                                >
                                    <span className="codicon codicon-comment" />
                                    <RowLabel>{thread.name}</RowLabel>
                                </Row>
                            ))}
                        </>
                    )}
                </Surface>
            )}
        </Root>
    );
}
