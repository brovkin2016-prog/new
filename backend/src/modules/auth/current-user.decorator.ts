import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  userId: string;
  email: string;
}

export const CurrentUser = createParamDecorator(
  (_data, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user,
);
