import { generateId } from '../utils/idGenerator';
import { StructuredLogger } from '../logger';
import { InferenceContext } from './inferutils/config.types';
import { selectTemplate } from './planning/templateSelector';
import { TemplateDetails } from '../services/sandbox/sandboxTypes';
import { createScratchTemplateDetails } from './utils/templates';
import { TemplateSelection } from './schemas';
import type { ImageAttachment } from '../types/image-attachment';
import { BaseSandboxService } from 'worker/services/sandbox/BaseSandboxService';
import { AgentState, CurrentDevState } from './core/state';
import type { CodeGeneratorAgent } from './core/codingAgent';
import { BehaviorType, ProjectType } from './core/types';

type AgentStubProps = {
    behaviorType?: BehaviorType;
    projectType?: ProjectType;
};

// `getAgentByName` (from the `agents` npm package) and `SandboxSdkClient`
// (worker/services/sandbox/sandboxSdkClient.ts) both pull in Workers-only
// `cloudflare:*` virtual modules at their own module scope. This barrel is
// imported eagerly by many controllers/middleware that `createApp`'s route
// registration loads unconditionally, so top-level static imports of either
// would make `createApp` unloadable under a plain Node/Vercel runtime even
// for requests that never reach an agent endpoint. Both are imported lazily
// inside the functions that need them instead - the same idiom already used
// for the sandbox SDK client in worker/services/sandbox/factory.ts.
// `CodeGeneratorAgent` above is `import type` for the same reason: it is
// only ever used here as a type argument, never a value.

export async function getAgentStub(
    env: Env,
    agentId: string,
    props?: AgentStubProps
) : Promise<DurableObjectStub<CodeGeneratorAgent>> {
    const { getAgentByName } = await import('agents');
    const options = props ? { props } : undefined;
    return getAgentByName<Env, CodeGeneratorAgent>(env.CodeGenObject, agentId, options);
}

export async function getAgentStubLightweight(env: Env, agentId: string) : Promise<DurableObjectStub<CodeGeneratorAgent>> {
    const { getAgentByName } = await import('agents');
    return getAgentByName<Env, CodeGeneratorAgent>(env.CodeGenObject, agentId, {
        // props: { readOnlyMode: true }
    });
}

export async function getAgentState(env: Env, agentId: string) : Promise<AgentState> {
    const agentInstance = await getAgentStub(env, agentId);
    return await agentInstance.getFullState() as AgentState;
}

export async function cloneAgent(env: Env, agentId: string) : Promise<{newAgentId: string, newAgent: DurableObjectStub<CodeGeneratorAgent>}> {
    const agentInstance = await getAgentStub(env, agentId);
    if (!agentInstance || !await agentInstance.isInitialized()) {
        throw new Error(`Agent ${agentId} not found`);
    }
    const newAgentId = generateId();

    const originalState = await agentInstance.getFullState();

    const newState: AgentState = {
        ...originalState,
        sessionId: newAgentId,
        sandboxInstanceId: undefined,
        pendingUserInputs: [],
        shouldBeGenerating: false,
        projectUpdatesAccumulator: [],
        reviewingInitiated: false,
        mvpGenerated: false,
        ...(originalState.behaviorType === 'phasic' ? {
            generatedPhases: [],
            currentDevState: CurrentDevState.IDLE,
        } : {}),
    } as AgentState;

    const newAgent = await getAgentStub(env, newAgentId, {
        behaviorType: originalState.behaviorType,
        projectType: originalState.projectType,
    });

    await newAgent.setState(newState);
    return {newAgentId, newAgent};
}

type TemplateQueryResult = { templateDetails: TemplateDetails; selection: TemplateSelection; projectType: ProjectType };

type TemplateQueryArgs = {
    env: Env;
    inferenceContext: InferenceContext;
    query: string;
    projectType: ProjectType | 'auto';
    images: ImageAttachment[] | undefined;
    logger: StructuredLogger;
    selectedTemplate?: string;
};

async function handleGeneralType(): Promise<TemplateQueryResult> {
    const scratch = createScratchTemplateDetails();
    const selection: TemplateSelection = {
        selectedTemplateName: null,
        reasoning: 'General (from-scratch) mode: no template selected',
        useCase: 'General',
        complexity: 'moderate',
        styleSelection: 'Custom',
        projectType: 'general',
    } as TemplateSelection;
    return { templateDetails: scratch, selection, projectType: 'general' };
}

async function handleUserSelectedTemplate(
    templateName: string,
    logger: StructuredLogger
): Promise<TemplateQueryResult> {
    logger.info('Using user-specified template, bypassing AI selection', { selectedTemplate: templateName });

    const { SandboxSdkClient } = await import('../services/sandbox/sandboxSdkClient');
    const templatesResponse = await SandboxSdkClient.listTemplates();
    if (!templatesResponse?.success) {
        throw new Error(`Failed to fetch templates from sandbox service, ${templatesResponse.error}`);
    }

    const matchedTemplate = templatesResponse.templates.find(t => t.name === templateName);
    if (!matchedTemplate) {
        throw new Error(`Specified template '${templateName}' not found in available templates`);
    }

    const templateDetailsResponse = await BaseSandboxService.getTemplateDetails(matchedTemplate.name);
    if (!templateDetailsResponse.success || !templateDetailsResponse.templateDetails) {
        throw new Error(`Failed to fetch template details for '${templateName}'`);
    }

    const selection: TemplateSelection = {
        selectedTemplateName: matchedTemplate.name,
        reasoning: 'User-specified template (AI selection bypassed)',
        useCase: 'General',
        complexity: 'moderate',
        styleSelection: 'Custom',
        projectType: matchedTemplate.projectType || 'app',
    };

    return {
        templateDetails: templateDetailsResponse.templateDetails,
        selection,
        projectType: matchedTemplate.projectType || 'app',
    };
}

async function handleAITemplateSelection(args: Omit<TemplateQueryArgs, 'selectedTemplate'>): Promise<TemplateQueryResult> {
    const { env, inferenceContext, query, projectType, images, logger } = args;

    const { SandboxSdkClient } = await import('../services/sandbox/sandboxSdkClient');
    const templatesResponse = await SandboxSdkClient.listTemplates();
    if (!templatesResponse?.success) {
        throw new Error(`Failed to fetch templates from sandbox service, ${templatesResponse.error}`);
    }

    const aiSelection = await selectTemplate({
        env,
        inferenceContext,
        query,
        projectType,
        availableTemplates: templatesResponse.templates,
        images,
    });

    logger.info('AI selected template', { selection: aiSelection });

    if (!aiSelection.selectedTemplateName) {
        logger.warn('No suitable template found; falling back to scratch');
        const scratch = createScratchTemplateDetails();
        return { templateDetails: scratch, selection: aiSelection, projectType: aiSelection.projectType };
    }

    const matchedTemplate = templatesResponse.templates.find(t => t.name === aiSelection.selectedTemplateName);
    if (!matchedTemplate) {
        logger.error('Selected template not found');
        throw new Error('Selected template not found');
    }

    const templateDetailsResponse = await BaseSandboxService.getTemplateDetails(matchedTemplate.name);
    if (!templateDetailsResponse.success || !templateDetailsResponse.templateDetails) {
        logger.error('Failed to fetch files', { templateDetailsResponse });
        throw new Error('Failed to fetch files');
    }

    return {
        templateDetails: templateDetailsResponse.templateDetails,
        selection: aiSelection,
        projectType: aiSelection.projectType,
    };
}

export async function getTemplateForQuery(
    env: Env,
    inferenceContext: InferenceContext,
    query: string,
    projectType: ProjectType | 'auto',
    images: ImageAttachment[] | undefined,
    logger: StructuredLogger,
    selectedTemplate?: string,
): Promise<TemplateQueryResult> {
    // Flow 1: General type - start from scratch
    if (projectType === 'general') {
        return handleGeneralType();
    }

    // Flow 2: User-specified template - bypass AI selection
    if (selectedTemplate && selectedTemplate !== 'auto') {
        return handleUserSelectedTemplate(selectedTemplate, logger);
    }

    // Flow 3: AI template selection
    return handleAITemplateSelection({ env, inferenceContext, query, projectType, images, logger });
}
