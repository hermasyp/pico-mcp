/*
 * The words of a Pico contract that the tool catalog spells out in its JSON Schemas: the HTTP methods,
 * the types a field may have and the kinds of request body. Pico owns the real lists; its repository
 * has a test that fails if these ever differ, so an agent is never told about a type Pico cannot hold.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const

export const FIELD_TYPES = ['string', 'int', 'number', 'boolean', 'object', 'list<object>', 'list<string>', 'list<int>', 'list<number>', 'list<boolean>', 'enum', 'file'] as const

export const BODY_TYPES = ['json', 'form-data', 'urlencoded', 'raw', 'none'] as const
