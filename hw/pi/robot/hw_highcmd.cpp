// 피지컬팀 mk2 — Go1 HighCmd 최소 송신기 (HW-R-06)
// 사용: hw_highcmd <vx> <vy> <wz> <seconds>
//   vx 전진(m/s), vy 좌우, wz 회전(rad/s), seconds 지속시간
// SDK 가 CRC 를 계산한다. 안전을 위해 C++ 안에 하드 상한을 박는다(인자 무관).
// 0속도면 mode=1(force stand, 제자리 자세유지), 속도가 있으면 mode=2(walk).
// 종료 시 항상 정지 프레임을 보낸다.
#include "unitree_legged_sdk/unitree_legged_sdk.h"
#include <cmath>
#include <cstring>
#include <unistd.h>
#include <cstdio>
#include <cstdlib>
using namespace UNITREE_LEGGED_SDK;

static float clampf(float v, float lo, float hi){ return v<lo?lo:(v>hi?hi:v); }

int main(int argc, char** argv){
    float vx = argc>1 ? atof(argv[1]) : 0.f;
    float vy = argc>2 ? atof(argv[2]) : 0.f;
    float wz = argc>3 ? atof(argv[3]) : 0.f;
    float secs = argc>4 ? atof(argv[4]) : 1.0f;

    // 하드 상한 — 인자가 뭐든 이 이상은 절대 안 나간다
    vx = clampf(vx, -0.30f, 0.30f);
    vy = clampf(vy, -0.30f, 0.30f);
    wz = clampf(wz, -0.50f, 0.50f);
    if (secs > 5.0f) secs = 5.0f;   // 한 번에 최대 5초

    bool moving = (fabs(vx)>1e-3 || fabs(vy)>1e-3 || fabs(wz)>1e-3);

    UDP udp(8090, "192.168.123.161", 8082, sizeof(HighCmd), sizeof(HighState));
    HighCmd cmd = {0};
    udp.InitCmdData(cmd);

    const float dt = 0.002f;              // 500Hz
    int steps = (int)(secs / dt);
    printf("[HighCmd] vx=%.3f vy=%.3f wz=%.3f mode=%d %.2fs\n",
           vx, vy, wz, moving?2:1, secs);

    for(int i=0;i<steps;i++){
        cmd.head[0]=0xFE; cmd.head[1]=0xEF;
        cmd.levelFlag = HIGHLEVEL;
        cmd.mode = moving ? 2 : 1;        // 2=walk, 1=force stand
        cmd.gaitType = moving ? 1 : 0;    // 1=trot
        cmd.speedLevel = 0;
        cmd.footRaiseHeight = 0;
        cmd.bodyHeight = 0;
        cmd.euler[0]=cmd.euler[1]=cmd.euler[2]=0;
        cmd.velocity[0]=vx; cmd.velocity[1]=vy;
        cmd.yawSpeed = wz;
        udp.SetSend(cmd);
        udp.Send();
        usleep((int)(dt*1e6));
    }
    // 정지 프레임 (force stand) 여러 번 — 깔끔히 서서 끝낸다
    for(int i=0;i<100;i++){
        cmd.mode=1; cmd.gaitType=0;
        cmd.velocity[0]=0; cmd.velocity[1]=0; cmd.yawSpeed=0;
        udp.SetSend(cmd); udp.Send();
        usleep(2000);
    }
    printf("[HighCmd] 종료 — 정지 프레임 전송 완료\n");
    return 0;
}
