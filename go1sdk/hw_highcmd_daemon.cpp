// 피지컬팀 mk2 — Go1 HighCmd 스트리밍 데몬 (HW-R-06)
// stdin 으로 "vx vy wz\n" 를 받아 500Hz 로 HighCmd 송출. 무입력 0.4초면 자동 정지.
// SDK 가 CRC 를 계산한다. 하드 상한(전진/좌우 0.3, 회전 0.5)을 C++ 에 박는다.
#include "unitree_legged_sdk/unitree_legged_sdk.h"
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <pthread.h>
#include <sys/time.h>
using namespace UNITREE_LEGGED_SDK;

static float g_vx=0, g_vy=0, g_wz=0;
static double g_last=0;
static pthread_mutex_t g_m = PTHREAD_MUTEX_INITIALIZER;

static double now_s(){ struct timeval t; gettimeofday(&t,0); return t.tv_sec + t.tv_usec*1e-6; }
static float clampf(float v,float lo,float hi){ return v<lo?lo:(v>hi?hi:v); }

// stdin 읽기 스레드
static void* reader(void*){
    char line[128];
    while (fgets(line, sizeof(line), stdin)){
        float vx=0,vy=0,wz=0;
        if (sscanf(line, "%f %f %f", &vx,&vy,&wz) >= 1){
            pthread_mutex_lock(&g_m);
            g_vx=clampf(vx,-0.3f,0.3f); g_vy=clampf(vy,-0.3f,0.3f); g_wz=clampf(wz,-0.5f,0.5f);
            g_last=now_s();
            pthread_mutex_unlock(&g_m);
        }
    }
    return 0;
}

int main(){
    UDP udp(8090, "192.168.123.161", 8082, sizeof(HighCmd), sizeof(HighState));
    HighCmd cmd = {0};
    udp.InitCmdData(cmd);
    setvbuf(stdin, 0, _IOLBF, 0);
    pthread_t th; pthread_create(&th, 0, reader, 0);
    fprintf(stderr, "[daemon] 준비 — stdin 'vx vy wz', 무입력 0.4s 정지\n");

    const double dt = 0.002;
    while (true){
        float vx,vy,wz; double last;
        pthread_mutex_lock(&g_m); vx=g_vx; vy=g_vy; wz=g_wz; last=g_last; pthread_mutex_unlock(&g_m);
        if (now_s() - last > 0.4){ vx=vy=wz=0; }   // 워치독: 명령 끊기면 정지
        bool moving = (fabs(vx)>1e-3 || fabs(vy)>1e-3 || fabs(wz)>1e-3);

        cmd.head[0]=0xFE; cmd.head[1]=0xEF; cmd.levelFlag=HIGHLEVEL;
        cmd.mode = moving?2:1; cmd.gaitType = moving?1:0; cmd.speedLevel=0;
        cmd.footRaiseHeight=0; cmd.bodyHeight=0;
        cmd.euler[0]=cmd.euler[1]=cmd.euler[2]=0;
        cmd.velocity[0]=vx; cmd.velocity[1]=vy; cmd.yawSpeed=wz;
        udp.SetSend(cmd); udp.Send();
        usleep((int)(dt*1e6));
    }
    return 0;
}
