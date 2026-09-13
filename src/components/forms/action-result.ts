/** Serializable result of a form server action (shared by server actions and client forms). */
export type ActionResult =
  | { status: "idle"; message?: undefined }
  | { status: "success"; message: string }
  | { status: "error"; message: string };

export const IDLE_RESULT: ActionResult = { status: "idle" };

export type FormAction = (prev: ActionResult, formData: FormData) => Promise<ActionResult>;
