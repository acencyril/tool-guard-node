// What Tool Guard decided about one call, and the message the model reads when it was blocked.

export const ALLOW = 'allow';
export const DENY = 'deny';
export const PENDING = 'pending';

export class Decision {
  constructor(verdict, reason = null, approvalId = null) {
    this.verdict = verdict;
    this.reason = reason;
    this.approvalId = approvalId;
    Object.freeze(this);
  }

  static allow() { return new Decision(ALLOW); }
  static deny(reason) { return new Decision(DENY, reason); }
  static pending(reason, approvalId = '') { return new Decision(PENDING, reason, approvalId); }

  get allowed() { return this.verdict === ALLOW; }
  get held() { return this.verdict === PENDING; }

  // Same wording as the Symfony bundle and the Python package.
  messageForModel() {
    if (this.verdict === DENY) {
      return `Refused by policy: ${this.reason}. Do not retry this action and do not try another way to do it; tell the user it is not possible.`;
    }
    if (this.verdict === PENDING) {
      return `This action needs a human approval (${this.reason}). Request ${this.approvalId} has been sent to the team; it is NOT done yet. Do not retry; tell the user it is pending review.`;
    }
    return '';
  }
}

export class ToolCallBlocked extends Error {
  constructor(decision, tool) {
    super(decision.messageForModel());
    this.name = 'ToolCallBlocked';
    this.decision = decision;
    this.tool = tool;
  }

  get held() { return this.decision.held; }
}
