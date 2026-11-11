import { MouseSensor, PointerSensor, TouchSensor } from "@dnd-kit/core";
import { flushSync } from "react-dom";

type MoveHandler = { handleMove: (event: Event) => void };
type PointerSensorClass = typeof MouseSensor | typeof TouchSensor | typeof PointerSensor;

/**
 * dnd-kit renders a pointer move at continuous priority, in a task after the frame that delivered the move,
 * so whatever follows the pointer (a drag overlay, a sorted list) trails it by a frame. A sensor made by
 * this renders each move before that frame paints. Activation, keyboard and drop are unchanged.
 */
export function framedMoves<T extends PointerSensorClass>(Base: T): T {
  const Framed = class extends (Base as typeof PointerSensor) {} as unknown as T;
  const base = (Base.prototype as unknown as MoveHandler).handleMove;
  (Framed.prototype as unknown as MoveHandler).handleMove = function framedMove(this: MoveHandler, event: Event) {
    flushSync(() => base.call(this, event));
  };
  return Framed;
}

export const FramedMouseSensor = framedMoves(MouseSensor);
export const FramedTouchSensor = framedMoves(TouchSensor);
export const FramedPointerSensor = framedMoves(PointerSensor);
