/*
 *  Copyright (c) 2026, WSO2 LLC. (http://www.wso2.com)
 *
 *  WSO2 LLC. licenses this file to you under the Apache License,
 *  Version 2.0 (the "License"); you may not use this file except
 *  in compliance with the License.
 *  You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 *  Unless required by applicable law or agreed to in writing,
 *  software distributed under the License is distributed on an
 *  "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 *  KIND, either express or implied.  See the License for the
 *  specific language governing permissions and limitations
 *  under the License.
 */

package io.ballerina.flowmodelgenerator.core.model.node;

import io.ballerina.compiler.syntax.tree.SyntaxKind;
import io.ballerina.flowmodelgenerator.core.Constants.Workflow;
import io.ballerina.flowmodelgenerator.core.model.NodeBuilder;
import io.ballerina.flowmodelgenerator.core.model.NodeKind;
import io.ballerina.flowmodelgenerator.core.model.Property;
import io.ballerina.flowmodelgenerator.core.model.SourceBuilder;
import io.ballerina.flowmodelgenerator.core.utils.WorkflowUtil;
import org.ballerinalang.langserver.common.utils.NameUtil;
import org.eclipse.lsp4j.TextEdit;

import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.CONTEXT_CLASS_NAME;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_MODULE;
import static io.ballerina.flowmodelgenerator.core.Constants.Workflow.WORKFLOW_ORG;

/**
 * Represents the workflow context's utility functions (the "Workflow Functions" palette group).
 * Each variant generates a simple typed binding of a {@code ctx.<method>()} call:
 *
 * <pre>{@code
 * time:Utc now = ctx.currentTime();
 * boolean replaying = ctx.isReplaying();
 * string workflowId = check ctx.getWorkflowId();
 * string workflowType = check ctx.getWorkflowType();
 * }</pre>
 *
 * @since 1.9.0
 */
public abstract class WorkflowContextFunctionBuilder extends NodeBuilder {

    // The static shape of one context utility function. `takesTaskName` marks the two that accept
    // an optional task name; the rest take no arguments.
    public record FunctionSpec(NodeKind kind, String methodName, String label, String description,
                               String resultType, boolean returnsError, String defaultVariableName,
                               String importOrg, String importModule, boolean takesTaskName) {

        FunctionSpec(NodeKind kind, String methodName, String label, String description, String resultType,
                     boolean returnsError, String defaultVariableName, String importOrg, String importModule) {
            this(kind, methodName, label, description, resultType, returnsError, defaultVariableName,
                    importOrg, importModule, false);
        }
    }

    // Every context utility function, by the method name a `ctx.<method>()` call carries, so
    // reading a workflow back can rebuild the same node the palette wrote.
    private static final Map<String, FunctionSpec> SPECS_BY_METHOD = new LinkedHashMap<>();

    private static void register(FunctionSpec spec) {
        SPECS_BY_METHOD.put(spec.methodName(), spec);
    }

    public static FunctionSpec specForMethod(String methodName) {
        return SPECS_BY_METHOD.get(methodName);
    }

    private static final String VARIABLE_NAME_LABEL = "Variable Name";
    private static final String VARIABLE_NAME_DESCRIPTION = "Variable name to receive the value.";

    protected abstract FunctionSpec spec();

    @Override
    public void setConcreteConstData() {
        FunctionSpec spec = spec();
        metadata().label(spec.label()).description(spec.description());
        codedata()
                .node(spec.kind())
                .org(WORKFLOW_ORG)
                .module(WORKFLOW_MODULE)
                .object(CONTEXT_CLASS_NAME)
                .symbol(spec.methodName());
    }

    @Override
    public void setConcreteTemplateData(TemplateContext context) {
        setConcreteConstData();
        FunctionSpec spec = spec();
        String variableName = NameUtil.generateTypeName(spec.defaultVariableName(),
                context.getAllVisibleSymbolNames());
        addVariableProperty(this, variableName);
        if (spec.takesTaskName()) {
            addTaskNameProperty(this, "");
        }
    }

    // The name the call's result binds to. Reading a workflow back builds the same field, so the
    // form a saved call opens in is the one the palette wrote.
    public static void addVariableProperty(NodeBuilder nodeBuilder, String variableName) {
        nodeBuilder.properties().custom()
                .metadata()
                    .label(VARIABLE_NAME_LABEL)
                    .description(VARIABLE_NAME_DESCRIPTION)
                    .stepOut()
                // Selected explicitly: a field whose only mode is unselected renders as blank.
                .type().fieldType(Property.ValueType.IDENTIFIER).selected(true).stepOut()
                .value(variableName)
                .editable(true)
                .stepOut()
                .addProperty(Property.VARIABLE_KEY);
    }

    // The optional `taskName` argument, as a plain string field: empty means the most recent task.
    public static void addTaskNameProperty(NodeBuilder nodeBuilder, String value) {
        nodeBuilder.properties().custom()
                .metadata()
                    .label(Workflow.CONTEXT_TASK_NAME_LABEL)
                    .description(Workflow.CONTEXT_TASK_NAME_DESCRIPTION)
                    .stepOut()
                .type().fieldType(Property.ValueType.TEXT).ballerinaType("string").selected(true).stepOut()
                .value(value)
                .editable(true)
                .optional(true)
                .stepOut()
                .addProperty(Workflow.CONTEXT_TASK_NAME_KEY);
    }

    @Override
    public Map<Path, List<TextEdit>> toSource(SourceBuilder sourceBuilder) {
        FunctionSpec spec = spec();
        String variableName = sourceBuilder.getProperty(Property.VARIABLE_KEY)
                .map(p -> p.value() == null ? null : p.value().toString())
                .filter(value -> !value.isBlank())
                .orElse(spec.defaultVariableName());

        String ctxParamName = ActivityCallBuilder.resolveContextParamName(sourceBuilder);

        sourceBuilder.token()
                .name(spec.resultType())
                .whiteSpace()
                .name(variableName)
                .whiteSpace()
                .keyword(SyntaxKind.EQUAL_TOKEN);
        if (spec.returnsError()) {
            sourceBuilder.token().keyword(SyntaxKind.CHECK_KEYWORD);
        }
        sourceBuilder.token()
                .name(ctxParamName)
                .keyword(SyntaxKind.DOT_TOKEN)
                .name(spec.methodName())
                .keyword(SyntaxKind.OPEN_PAREN_TOKEN);
        if (spec.takesTaskName()) {
            sourceBuilder.getProperty(Workflow.CONTEXT_TASK_NAME_KEY)
                    .map(property -> property.value() == null ? "" : property.value().toString().trim())
                    .filter(taskName -> !taskName.isBlank())
                    .ifPresent(taskName -> sourceBuilder.token()
                            .name(WorkflowUtil.quoteIfPlain(taskName)));
        }
        sourceBuilder.token()
                .keyword(SyntaxKind.CLOSE_PAREN_TOKEN)
                .endOfStatement();

        sourceBuilder.textEdit().acceptImport(WORKFLOW_ORG, WORKFLOW_MODULE);
        if (spec.importModule() != null) {
            sourceBuilder.acceptImport(spec.importOrg(), spec.importModule());
        }
        return sourceBuilder.build();
    }

    /** Generates {@code time:Utc now = ctx.currentTime();}. */
    public static class CurrentTime extends WorkflowContextFunctionBuilder {

        private static final FunctionSpec SPEC = new FunctionSpec(NodeKind.WORKFLOW_CURRENT_TIME,
                Workflow.CURRENT_TIME_METHOD_NAME, Workflow.CURRENT_TIME_LABEL, Workflow.CURRENT_TIME_DESCRIPTION,
                "time:Utc", false, "now", "ballerina", "time");

        @Override
        protected FunctionSpec spec() {
            return SPEC;
        }
    }

    /** Generates {@code boolean replaying = ctx.isReplaying();}. */
    public static class IsReplaying extends WorkflowContextFunctionBuilder {

        private static final FunctionSpec SPEC = new FunctionSpec(NodeKind.WORKFLOW_IS_REPLAYING,
                Workflow.IS_REPLAYING_METHOD_NAME, Workflow.IS_REPLAYING_LABEL, Workflow.IS_REPLAYING_DESCRIPTION,
                "boolean", false, "replaying", null, null);

        @Override
        protected FunctionSpec spec() {
            return SPEC;
        }
    }

    /** Generates {@code string workflowId = check ctx.getWorkflowId();}. */
    public static class GetWorkflowId extends WorkflowContextFunctionBuilder {

        private static final FunctionSpec SPEC = new FunctionSpec(NodeKind.WORKFLOW_GET_ID,
                Workflow.GET_WORKFLOW_ID_METHOD_NAME, Workflow.GET_WORKFLOW_ID_LABEL,
                Workflow.GET_WORKFLOW_ID_DESCRIPTION, "string", true, "workflowId", null, null);

        @Override
        protected FunctionSpec spec() {
            return SPEC;
        }
    }

    /** Generates {@code workflow:HumanTaskCompletion? completion = ctx.lastHumanTaskCompletion();}. */
    public static class LastHumanTaskCompletion extends WorkflowContextFunctionBuilder {

        private static final FunctionSpec SPEC = new FunctionSpec(NodeKind.WORKFLOW_LAST_HUMAN_TASK_COMPLETION,
                Workflow.LAST_HUMAN_TASK_COMPLETION_METHOD_NAME, Workflow.LAST_HUMAN_TASK_COMPLETION_LABEL,
                Workflow.LAST_HUMAN_TASK_COMPLETION_DESCRIPTION, Workflow.HUMAN_TASK_COMPLETION_TYPE, false,
                "completion", null, null, true);

        @Override
        protected FunctionSpec spec() {
            return SPEC;
        }
    }

    /** Generates {@code workflow:ReviewDecisionRecord? decision = ctx.lastReviewDecision();}. */
    public static class LastReviewDecision extends WorkflowContextFunctionBuilder {

        private static final FunctionSpec SPEC = new FunctionSpec(NodeKind.WORKFLOW_LAST_REVIEW_DECISION,
                Workflow.LAST_REVIEW_DECISION_METHOD_NAME, Workflow.LAST_REVIEW_DECISION_LABEL,
                Workflow.LAST_REVIEW_DECISION_DESCRIPTION, Workflow.REVIEW_DECISION_TYPE, false,
                "decision", null, null, true);

        @Override
        protected FunctionSpec spec() {
            return SPEC;
        }
    }

    /** Generates {@code string workflowType = check ctx.getWorkflowType();}. */
    public static class GetWorkflowType extends WorkflowContextFunctionBuilder {

        private static final FunctionSpec SPEC = new FunctionSpec(NodeKind.WORKFLOW_GET_TYPE,
                Workflow.GET_WORKFLOW_TYPE_METHOD_NAME, Workflow.GET_WORKFLOW_TYPE_LABEL,
                Workflow.GET_WORKFLOW_TYPE_DESCRIPTION, "string", true, "workflowType", null, null);

        @Override
        protected FunctionSpec spec() {
            return SPEC;
        }
    }

    static {
        register(CurrentTime.SPEC);
        register(IsReplaying.SPEC);
        register(GetWorkflowId.SPEC);
        register(GetWorkflowType.SPEC);
        register(LastHumanTaskCompletion.SPEC);
        register(LastReviewDecision.SPEC);
    }
}
