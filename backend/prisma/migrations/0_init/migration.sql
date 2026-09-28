-- CreateEnum
CREATE TYPE "TaskType" AS ENUM ('positions', 'audit', 'semantics', 'competitors');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('active', 'paused', 'archived');

-- CreateEnum
CREATE TYPE "RunStatus" AS ENUM ('queued', 'running', 'success', 'failed', 'stopped');

-- CreateEnum
CREATE TYPE "Intent" AS ENUM ('commercial', 'informational', 'mixed', 'unknown');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "maxProjects" INTEGER NOT NULL DEFAULT 10,
    "maxPagesPerRun" INTEGER NOT NULL DEFAULT 15,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "targetUrl" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "code" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "parent" INTEGER,

    CONSTRAINT "Region_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "ProjectRegion" (
    "projectId" TEXT NOT NULL,
    "regionCode" INTEGER NOT NULL,

    CONSTRAINT "ProjectRegion_pkey" PRIMARY KEY ("projectId","regionCode")
);

-- CreateTable
CREATE TABLE "Keyword" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "phrase" TEXT NOT NULL,
    "regionCode" INTEGER,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "frequency" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Keyword_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "name" TEXT NOT NULL,
    "params" JSONB NOT NULL DEFAULT '{}',
    "cron" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "status" "RunStatus" NOT NULL DEFAULT 'queued',
    "params" JSONB NOT NULL DEFAULT '{}',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaskRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RunLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RunLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PositionResult" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,
    "regionCode" INTEGER NOT NULL,
    "position" INTEGER,
    "url" TEXT,
    "inTop30" BOOLEAN NOT NULL DEFAULT false,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PositionResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditPage" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseMs" INTEGER,
    "lcpMs" INTEGER,
    "fcpMs" INTEGER,
    "ttiMs" INTEGER,
    "title" TEXT,
    "description" TEXT,
    "headings" JSONB NOT NULL DEFAULT '{}',
    "issues" JSONB NOT NULL DEFAULT '[]',
    "depth" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BrokenLink" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fromUrl" TEXT NOT NULL,
    "toUrl" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,

    CONSTRAINT "BrokenLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SemanticCore" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SemanticCore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Cluster" (
    "id" TEXT NOT NULL,
    "coreId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "intent" "Intent" NOT NULL DEFAULT 'unknown',
    "volume" INTEGER NOT NULL DEFAULT 0,
    "difficulty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "commercialValue" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "potentialTraffic" INTEGER NOT NULL DEFAULT 0,
    "priority" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "competitorUrls" JSONB NOT NULL DEFAULT '[]',
    "isGap" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClusterKeyword" (
    "clusterId" TEXT NOT NULL,
    "keywordId" TEXT NOT NULL,

    CONSTRAINT "ClusterKeyword_pkey" PRIMARY KEY ("clusterId","keywordId")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" "TaskType" NOT NULL,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Project_userId_idx" ON "Project"("userId");

-- CreateIndex
CREATE INDEX "Keyword_projectId_idx" ON "Keyword"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "Keyword_projectId_phrase_regionCode_key" ON "Keyword"("projectId", "phrase", "regionCode");

-- CreateIndex
CREATE INDEX "Task_projectId_idx" ON "Task"("projectId");

-- CreateIndex
CREATE INDEX "TaskRun_taskId_idx" ON "TaskRun"("taskId");

-- CreateIndex
CREATE INDEX "RunLog_runId_idx" ON "RunLog"("runId");

-- CreateIndex
CREATE INDEX "PositionResult_keywordId_regionCode_checkedAt_idx" ON "PositionResult"("keywordId", "regionCode", "checkedAt");

-- CreateIndex
CREATE INDEX "PositionResult_runId_idx" ON "PositionResult"("runId");

-- CreateIndex
CREATE INDEX "AuditPage_runId_idx" ON "AuditPage"("runId");

-- CreateIndex
CREATE INDEX "BrokenLink_runId_idx" ON "BrokenLink"("runId");

-- CreateIndex
CREATE UNIQUE INDEX "SemanticCore_projectId_key" ON "SemanticCore"("projectId");

-- CreateIndex
CREATE INDEX "Cluster_coreId_idx" ON "Cluster"("coreId");

-- CreateIndex
CREATE UNIQUE INDEX "Report_runId_key" ON "Report"("runId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRegion" ADD CONSTRAINT "ProjectRegion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRegion" ADD CONSTRAINT "ProjectRegion_regionCode_fkey" FOREIGN KEY ("regionCode") REFERENCES "Region"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Keyword" ADD CONSTRAINT "Keyword_regionCode_fkey" FOREIGN KEY ("regionCode") REFERENCES "Region"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskRun" ADD CONSTRAINT "TaskRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunLog" ADD CONSTRAINT "RunLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionResult" ADD CONSTRAINT "PositionResult_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PositionResult" ADD CONSTRAINT "PositionResult_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditPage" ADD CONSTRAINT "AuditPage_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BrokenLink" ADD CONSTRAINT "BrokenLink_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SemanticCore" ADD CONSTRAINT "SemanticCore_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Cluster" ADD CONSTRAINT "Cluster_coreId_fkey" FOREIGN KEY ("coreId") REFERENCES "SemanticCore"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterKeyword" ADD CONSTRAINT "ClusterKeyword_clusterId_fkey" FOREIGN KEY ("clusterId") REFERENCES "Cluster"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClusterKeyword" ADD CONSTRAINT "ClusterKeyword_keywordId_fkey" FOREIGN KEY ("keywordId") REFERENCES "Keyword"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaskRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

