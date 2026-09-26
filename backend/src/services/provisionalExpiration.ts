import { prisma } from '../lib/prisma';

export async function expireProvisionalTeams(now = new Date()): Promise<number> {
  const expiredTeams = await prisma.provisionalTeam.findMany({
    where: {
      status: 'pending',
      expiresAt: { lte: now },
    },
    select: { id: true, eventId: true, chatRoomId: true },
    take: 100,
  });

  let expiredCount = 0;

  for (const candidate of expiredTeams) {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${candidate.id}))`;

      const team = await tx.provisionalTeam.findUnique({
        where: { id: candidate.id },
        include: { members: true },
      });

      if (!team || team.status !== 'pending' || team.expiresAt > now) {
        return null;
      }

      await tx.provisionalTeam.update({
        where: { id: team.id },
        data: { status: 'expired' },
      });

      for (const member of team.members.filter((m) => ['pending', 'accepted'].includes(m.status))) {
        await tx.provisionalTeamMember.update({
          where: {
            provisionalTeamId_userId: {
              provisionalTeamId: team.id,
              userId: member.userId,
            },
          },
          data: { status: 'expired', respondedAt: now },
        });

        await tx.eventParticipant.update({
          where: {
            eventId_userId: {
              eventId: team.eventId,
              userId: member.userId,
            },
          },
          data: {
            status: 'looking_for_team',
            provisionalTeamId: null,
          },
        });
      }

      if (team.chatRoomId) {
        await tx.chatRoom.update({
          where: { id: team.chatRoomId },
          data: { status: 'archived' },
        });
      }

      return {
        eventId: team.eventId,
        userIds: team.members
          .filter((m) => ['pending', 'accepted'].includes(m.status))
          .map((m) => m.userId),
      };
    });

    if (result) {
      expiredCount++;
    }
  }

  return expiredCount;
}
