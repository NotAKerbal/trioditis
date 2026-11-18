import { createApi } from '@convex-dev/better-auth'
import { createAuthOptions } from '../auth'
import schema from './schema'

// The functions Better Auth reads and writes its tables with, as `components.betterAuth.adapter`.
export const { create, findOne, findMany, updateOne, updateMany, deleteOne, deleteMany, consumeOne, incrementOne } =
  createApi(schema, createAuthOptions)
