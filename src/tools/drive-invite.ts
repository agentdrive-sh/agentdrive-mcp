import { z } from 'zod';
import type { ApiClient } from '../api-client.js';

export const driveInviteSchema = {
  email: z.string().describe('Email address of the human to invite to your organization'),
  role: z.enum(['owner', 'admin', 'member']).default('member').describe('Role in the organization (default: member)'),
};

export async function driveInvite(client: ApiClient, args: {
  email: string;
  role: 'owner' | 'admin' | 'member';
}) {
  const invite = await client.inviteMember(args.email, args.role);

  return {
    content: [{
      type: 'text' as const,
      text: `Invited ${invite.email} as ${invite.role}. The invite is pending: they join only after they sign in to AgentDrive and accept it (expires ${invite.expires_at.split('T')[0]}).`,
    }],
  };
}
