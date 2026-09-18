import ballerina/time;
import ballerina/workflow;

# Workflow that reads every context utility function
@workflow:Workflow
function claimWorkflow(workflow:Context ctx) returns error? {
    time:Utc now = ctx.currentTime();
    boolean replaying = ctx.isReplaying();
    string workflowId = check ctx.getWorkflowId();
    string workflowType = check ctx.getWorkflowType();
    workflow:HumanTaskCompletion? completion = ctx.lastHumanTaskCompletion();
    workflow:ReviewDecisionRecord? decision = ctx.lastReviewDecision("approveClaim");
    workflow:ReviewDecisionRecord? secondLook = ();
    secondLook = ctx.lastReviewDecision("review\ttwo");
}
