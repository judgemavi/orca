import { and, desc, eq } from 'drizzle-orm';
import type { OrcaDrizzleDB } from '../db/connection';
import { type TaskQuestionEntry, taskQuestions } from '../db/schema';

export async function createQuestion(
  db: OrcaDrizzleDB,
  input: {
    taskId: string;
    interactionId?: string;
    question: string;
  },
): Promise<TaskQuestionEntry> {
  const rows = await db
    .insert(taskQuestions)
    .values({
      taskId: input.taskId,
      interactionId: input.interactionId ?? null,
      question: input.question,
      status: 'pending',
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error('failed to create task question');
  return row;
}

export async function answerQuestion(
  db: OrcaDrizzleDB,
  id: string,
  answer: string,
): Promise<TaskQuestionEntry> {
  const result = await db
    .update(taskQuestions)
    .set({
      answer,
      status: 'answered',
      answeredAt: new Date().toISOString(),
    })
    .where(eq(taskQuestions.id, id))
    .returning();
  const row = result[0];
  if (!row) throw new Error(`question not found: ${id}`);
  return row;
}

export async function getQuestion(
  db: OrcaDrizzleDB,
  id: string,
): Promise<TaskQuestionEntry> {
  const rows = await db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`question not found: ${id}`);
  return row;
}

export async function getPendingForTask(
  db: OrcaDrizzleDB,
  taskId: string,
): Promise<TaskQuestionEntry> {
  const rows = await db
    .select()
    .from(taskQuestions)
    .where(
      and(
        eq(taskQuestions.taskId, taskId),
        eq(taskQuestions.status, 'pending'),
      ),
    )
    .orderBy(desc(taskQuestions.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`pending question not found for task ${taskId}`);
  return row;
}

export async function listQuestionsForTask(
  db: OrcaDrizzleDB,
  taskId: string,
): Promise<TaskQuestionEntry[]> {
  const rows = await db
    .select()
    .from(taskQuestions)
    .where(eq(taskQuestions.taskId, taskId))
    .orderBy(desc(taskQuestions.createdAt));
  return rows;
}
