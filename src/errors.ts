import { GhuriError } from '@ghuri/core'

/** The task attempting to be enqueued is invalid (bad arguments, or a feature its backend does not support). */
export class InvalidTask extends GhuriError {}

/** The requested task backend is not configured or not usable. */
export class InvalidTaskBackend extends GhuriError {}

/** `getResult()` was given an id that does not exist. */
export class TaskResultDoesNotExist extends GhuriError {}

/** `getResult()` was given the id of another task's result. */
export class TaskResultMismatch extends GhuriError {}

/** `returnValue` was read before the task finished successfully (Django raises `ValueError`). */
export class TaskResultNotReady extends GhuriError {}

/** The backend does not implement this operation (Django raises `NotImplementedError`), e.g. `getResult()`. */
export class NotImplementedError extends GhuriError {}
