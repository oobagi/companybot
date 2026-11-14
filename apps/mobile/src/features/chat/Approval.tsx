import type { FunctionReturnType } from 'convex/server';
import { Button, Card, ErrorState, Stack, Text } from '@/components/ui';
import { api } from '@/lib/api';
import { useMutation, useQuery } from '@/lib/convex';
import { useTask } from '@/lib/useTask';
import type { Message } from './types';
import { approvalFailure } from './approvalOutcome';

type Approval = FunctionReturnType<typeof api.approvals.forReply>[number];
export function Approvals({ message }: { message: Message }) {
  const approvals = useQuery(api.approvals.forReply, { replyId: message._id });
  return <Stack>{message.parts.filter((p) => p.type === 'approval').map((part) => <ApprovalCard key={part.id} approval={approvals?.find((a) => a.callId === part.id)} reason={part.why ?? part.tool} loaded={approvals !== undefined} />)}</Stack>;
}
function ApprovalCard({ approval, reason, loaded }: { approval?: Approval; reason: string; loaded: boolean }) {
  const decide = useMutation(api.approvals.decide);
  const task = useTask();
  const act = (approve: boolean, always = false) => approval && task.run(() => decide({ approvalId: approval._id, hash: approval.hash, approve, always }));
  let input = approval?.input ?? '';
  try { input = JSON.stringify(JSON.parse(input), null, 2); } catch { /* Preserve exact input if a future server format changes. */ }
  return <Card><Text>{reason}</Text>{approval ? <>
    <Text variant="label">{[approval.service, approval.action].filter(Boolean).join(' · ')}</Text>
    {approval.automation && <Text variant="caption" tone="muted">Automation: {approval.automation}</Text>}
    <Text selectable>{input}</Text>
    {approval.status === 'pending' ? approval.canDecide ? <Stack>
      <Text variant="caption" tone="muted">Expires {new Date(approval.expiresAt).toLocaleString()}</Text>
      <Button label="Allow once" loading={task.busy} onPress={() => void act(true)} />
      {approval.alwaysText && <><Button label={approval.alwaysAutomation ? 'Always for this automation' : 'Always allow'} variant="secondary" disabled={task.busy} onPress={() => void act(true, true)} /><Text variant="caption" tone="muted">{approval.alwaysText}</Text></>}
      <Button label="Deny" variant="ghost" disabled={task.busy} onPress={() => void act(false)} />
    </Stack> : <Text tone="muted">Waiting for {approval.approver}. Only they can answer.</Text> : <Text tone={approval.status === 'failed' && !approvalFailure(approval).uncertain ? 'danger' : 'muted'}>{approval.status === 'done' ? `Done · ${approval.always ? 'Always allowed' : 'Allowed once'} by ${approval.approver}` : approval.status === 'denied' ? `Denied by ${approval.approver}. Nothing ran.` : approval.status === 'expired' ? 'Expired. Nothing ran.' : approval.status === 'failed' ? approvalFailure(approval).text : 'Approved · running…'}</Text>}
    {task.error && <ErrorState message={task.error} />}
  </> : <Text tone="muted">{loaded ? 'Approval no longer available.' : 'Loading exact action…'}</Text>}</Card>;
}
