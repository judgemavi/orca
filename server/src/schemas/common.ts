import { z } from 'zod';

export const nonEmptyTrimmedString = z.string().trim().min(1);
export const optionalNonEmptyTrimmedString = nonEmptyTrimmedString.optional();
export const optionalStringField = z.string().optional();

export const unknownRecordSchema = z.record(z.string(), z.unknown());
export const booleanRecordSchema = z.record(z.string(), z.boolean());
