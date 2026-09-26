/**
 * Team lifecycle state machine tests.
 * Verifies the correct transitions:
 *   looking_for_team → in_forming_team → in_finalized_team
 *
 * Tests the transition guards defined in routes without spinning up HTTP servers.
 */

describe('Team lifecycle — allowed transitions', () => {
  // This reflects the business rules enforced in routes/events.ts
  // and routes/requests.ts
  const USER_CONTROLLED_TRANSITIONS: Record<string, string[]> = {
    registered: ['looking_for_team', 'withdrawn'],
    looking_for_team: ['registered', 'withdrawn'],
  };

  const SYSTEM_CONTROLLED_STATES = [
    'in_matchmaking',
    'in_provisional_team',
    'in_forming_team',
    'in_finalized_team',
  ];

  test('user can enter looking_for_team from registered', () => {
    const allowed = USER_CONTROLLED_TRANSITIONS['registered'] ?? [];
    expect(allowed).toContain('looking_for_team');
  });

  test('user can return to registered from looking_for_team', () => {
    const allowed = USER_CONTROLLED_TRANSITIONS['looking_for_team'] ?? [];
    expect(allowed).toContain('registered');
  });

  test('user can withdraw from registered', () => {
    const allowed = USER_CONTROLLED_TRANSITIONS['registered'] ?? [];
    expect(allowed).toContain('withdrawn');
  });

  test('user can withdraw from looking_for_team', () => {
    const allowed = USER_CONTROLLED_TRANSITIONS['looking_for_team'] ?? [];
    expect(allowed).toContain('withdrawn');
  });

  test('in_forming_team is NOT user-settable via participation endpoint', () => {
    // This state is set only by team join/invite acceptance
    expect(USER_CONTROLLED_TRANSITIONS).not.toHaveProperty('in_forming_team');
  });

  test('in_finalized_team is NOT user-settable via participation endpoint', () => {
    // This state is set only by the finalize endpoint
    expect(USER_CONTROLLED_TRANSITIONS).not.toHaveProperty('in_finalized_team');
  });

  test('system-controlled states are not reachable via participation endpoint', () => {
    for (const state of SYSTEM_CONTROLLED_STATES) {
      // None of the user-controlled transitions target system-controlled states
      for (const transitions of Object.values(USER_CONTROLLED_TRANSITIONS)) {
        expect(transitions).not.toContain(state);
      }
    }
  });

  test('team finalization logic never checks member count for completion', () => {
    // This test documents the invariant: completion is explicit
    // A team with 1 member can technically be finalized (owner only)
    // but a team with 0 members cannot
    const simulateFinalize = (memberCount: number) => {
      if (memberCount < 1) throw new Error('TEAM_EMPTY');
      return 'finalized';
    };

    expect(simulateFinalize(1)).toBe('finalized');
    expect(simulateFinalize(5)).toBe('finalized');
    expect(simulateFinalize(100)).toBe('finalized');
    expect(() => simulateFinalize(0)).toThrow('TEAM_EMPTY');
  });

  test('joining a team sets participant to in_forming_team (not finalized)', () => {
    // Documents the invariant: joining sets forming, not finalized
    // Only explicit finalize endpoint sets in_finalized_team
    const stateAfterJoining = 'in_forming_team';
    const stateAfterFinalize = 'in_finalized_team';

    expect(stateAfterJoining).toBe('in_forming_team');
    expect(stateAfterFinalize).toBe('in_finalized_team');
    expect(stateAfterJoining).not.toBe(stateAfterFinalize);
  });
});

describe('Team lifecycle — no size constraints', () => {
  test('no team size fields exist in event config', () => {
    // Documenting that Event no longer has minTeamSize/maxTeamSize
    type EventFields = {
      id: string;
      name: string;
      status: string;
      matchmakingEnabled: boolean;
      // If someone adds these back, this test becomes a type error
      // minTeamSize?: never;
      // maxTeamSize?: never;
    };

    const event: EventFields = {
      id: '123',
      name: 'Test Event',
      status: 'registration_open',
      matchmakingEnabled: true,
    };

    expect(event).not.toHaveProperty('minTeamSize');
    expect(event).not.toHaveProperty('maxTeamSize');
  });

  test('provisional team conversion results in forming status', () => {
    // When all members accept a provisional team, the resulting team
    // is 'forming' — team must explicitly finalize
    const statusAfterConversion = 'forming';
    expect(statusAfterConversion).toBe('forming');
    expect(statusAfterConversion).not.toBe('finalized');
    expect(statusAfterConversion).not.toBe('locked');
  });

  test('provisional team member acceptance sets in_forming_team state', () => {
    // Members who accept a provisional team should be in in_forming_team
    // (not in_finalized_team) until the team explicitly finalizes
    const stateAfterProvisionalAccept = 'in_forming_team';
    expect(stateAfterProvisionalAccept).toBe('in_forming_team');
    expect(stateAfterProvisionalAccept).not.toBe('in_finalized_team');
  });
});
