import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private hash(password: string): string {
    const salt = randomBytes(16).toString('hex');
    const derived = scryptSync(password, salt, 64).toString('hex');
    return `${salt}:${derived}`;
  }

  private verify(password: string, stored: string): boolean {
    const [salt, key] = stored.split(':');
    const derived = scryptSync(password, salt, 64);
    const keyBuf = Buffer.from(key, 'hex');
    return keyBuf.length === derived.length && timingSafeEqual(keyBuf, derived);
  }

  async register(email: string, password: string, name?: string) {
    const exists = await this.prisma.user.findUnique({ where: { email } });
    if (exists) throw new ConflictException('Email уже зарегистрирован');
    const user = await this.prisma.user.create({
      data: { email, password: this.hash(password), name },
    });
    return this.token(user.id, user.email);
  }

  async login(email: string, password: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !this.verify(password, user.password)) {
      throw new UnauthorizedException('Неверные учётные данные');
    }
    return this.token(user.id, user.email);
  }

  private token(sub: string, email: string) {
    return { accessToken: this.jwt.sign({ sub, email }) };
  }
}
