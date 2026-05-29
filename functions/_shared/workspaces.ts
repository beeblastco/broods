/**
 * Workspace namespace resolution shared by runtime sessions and cleanup.
 * Keep config-to-filesystem binding rules here.
 */

import { normalizeFilesystemNamespace } from "./runtime-keys.ts";
import type { AgentConfig, AgentWorkspaceDefinitionConfig } from "./storage/index.ts";

export interface WorkspaceBinding {
  id: string;
  namespace: string;
  description?: string;
  isDefault: boolean;
}

interface WorkspaceResolutionContext {
  accountId?: string;
  agentId?: string;
  conversationKey: string;
}

interface ConfiguredWorkspaceNamespaceContext {
  accountId: string;
  agentId: string;
}

const DEFAULT_WORKSPACE_ID = "default";

export function resolveWorkspaceBindings(
  agentConfig: AgentConfig,
  context: WorkspaceResolutionContext,
): WorkspaceBinding[] {
  const workspace = agentConfig.workspace ?? {};
  const configuredWorkspaces = workspace.workspaces;
  if (configuredWorkspaces && Object.keys(configuredWorkspaces).length > 0) {
    const workspaceIds = Object.keys(configuredWorkspaces);
    const defaultWorkspaceId = workspace.defaultWorkspace
      ?? (workspaceIds.includes(DEFAULT_WORKSPACE_ID) ? DEFAULT_WORKSPACE_ID : workspaceIds[0]!);

    return workspaceIds.map((id) => {
      const config = configuredWorkspaces[id] ?? {};
      return toWorkspaceBinding(
        id,
        {
          ...config,
          namespace: config.namespace ?? (id === defaultWorkspaceId ? legacyWorkspaceNamespace(agentConfig) : undefined),
        },
        context,
        id === defaultWorkspaceId,
        false,
      );
    });
  }

  return [toWorkspaceBinding(
    DEFAULT_WORKSPACE_ID,
    { namespace: legacyWorkspaceNamespace(agentConfig) },
    context,
    true,
    true,
  )];
}

export function resolveDefaultWorkspaceBinding(
  agentConfig: AgentConfig,
  context: WorkspaceResolutionContext,
): WorkspaceBinding {
  const bindings = resolveWorkspaceBindings(agentConfig, context);
  return bindings.find((binding) => binding.isDefault) ?? bindings[0]!;
}

export function resolveConfiguredWorkspaceNamespaces(
  agentConfig: AgentConfig,
  context: ConfiguredWorkspaceNamespaceContext,
): string[] {
  const workspace = agentConfig.workspace ?? {};
  const configuredWorkspaces = workspace.workspaces;
  const logicalNamespaces = new Set<string>();

  if (configuredWorkspaces && Object.keys(configuredWorkspaces).length > 0) {
    const defaultWorkspaceId = workspace.defaultWorkspace
      ?? (Object.prototype.hasOwnProperty.call(configuredWorkspaces, DEFAULT_WORKSPACE_ID)
        ? DEFAULT_WORKSPACE_ID
        : Object.keys(configuredWorkspaces)[0]);

    for (const [id, config] of Object.entries(configuredWorkspaces)) {
      const namespace = config.namespace ?? (id === defaultWorkspaceId ? legacyWorkspaceNamespace(agentConfig) : undefined);
      if (namespace) {
        logicalNamespaces.add(namespace);
      }
    }
  } else {
    const namespace = legacyWorkspaceNamespace(agentConfig);
    if (namespace) {
      logicalNamespaces.add(namespace);
    }
  }

  return [...logicalNamespaces].map((logicalNamespace) =>
    normalizeFilesystemNamespace(`${context.accountId}:${context.agentId}:${logicalNamespace}`));
}

function toWorkspaceBinding(
  id: string,
  config: AgentWorkspaceDefinitionConfig,
  context: WorkspaceResolutionContext,
  isDefault: boolean,
  preserveLegacyConversationNamespace: boolean,
): WorkspaceBinding {
  const logicalNamespace = config.namespace
    ?? (preserveLegacyConversationNamespace ? context.conversationKey : `workspace:${id}:${context.conversationKey}`);
  const accountScope = context.accountId && context.agentId
    ? `${context.accountId}:${context.agentId}`
    : context.accountId;
  const scopedNamespace = accountScope ? `${accountScope}:${logicalNamespace}` : logicalNamespace;

  return {
    id,
    namespace: normalizeFilesystemNamespace(scopedNamespace),
    ...(config.description ? { description: config.description } : {}),
    isDefault,
  };
}

function legacyWorkspaceNamespace(agentConfig: AgentConfig): string | undefined {
  return agentConfig.workspace?.namespace ?? agentConfig.workspace?.memory?.namespace;
}
