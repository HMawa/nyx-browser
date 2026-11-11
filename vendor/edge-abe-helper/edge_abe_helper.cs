// edge_abe_helper.cs — Edge App-Bound Encryption 解密助手
//
// 背景：Edge 149 起（Chromium 127+ 的 ABE），Cookie 的 encrypted_value 用
// app_bound_encrypted_key 加密，而该 key 只能通过 Edge 的 elevation_service
// COM 服务解密。COM 服务会校验调用进程的 exe 路径必须在 Edge 安装目录内，
// 因此本 helper 必须被复制到 Edge Application 目录后运行。
//
// 用法（均由 Nyx 主进程 edge-cookie-import.js 拉起）：
//   edge_abe_helper.exe decrypt-key <base64(app_bound_encrypted_key)>
//       -> OK:<hex 32B AES key>
//   edge_abe_helper.exe decrypt-value <base64(encrypted_value)>
//       -> OK:<base64 明文> / ERR:<0xHRESULT>:<lastError>
//   edge_abe_helper.exe decrypt-values
//       stdin 每行一个 base64(encrypted_value)，stdout 每行一个结果
//
// 说明：C# 编译用 .NET Framework 自带 csc.exe（C# 5），因此不使用
// 字符串插值 / out var / using var 等新语法。
//
// Edge 144+ 接口链（影响 vtable 布局）：
//   IUnknown(3) + IEdgeElevatorBase_Placeholder(3 个未知方法)
//   + RunRecoveryCRXElevated + EncryptData + DecryptData
// DecryptData 位于 vtable offset 64（index 8），与 DeepWiki 记录一致。
// 主用 IID {C9C2B807-7731-4F34-81B7-44FF77795222}，备选 {…9522B}。

using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

namespace NyxEdgeAbeHelper
{
    [ComImport, Guid("C9C2B807-7731-4F34-81B7-44FF77795222"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEdgeElevator2Final
    {
        [PreserveSig] int Placeholder1();
        [PreserveSig] int Placeholder2();
        [PreserveSig] int Placeholder3();
        [PreserveSig] int RunRecoveryCRXElevated(
            [MarshalAs(UnmanagedType.LPWStr)] string crx_path,
            [MarshalAs(UnmanagedType.LPWStr)] string browser_appid,
            [MarshalAs(UnmanagedType.LPWStr)] string browser_version,
            [MarshalAs(UnmanagedType.LPWStr)] string session_id,
            uint caller_proc_id, out IntPtr proc_handle);
        [PreserveSig] int EncryptData(int protection_level,
            [MarshalAs(UnmanagedType.BStr)] string plaintext,
            out IntPtr ciphertext, out int last_error);
        [PreserveSig] int DecryptData(
            IntPtr ciphertext,
            out IntPtr plaintext, out int last_error);
    }

    [ComImport, Guid("C9C2B807-7731-4F34-81B7-44FF7779522B"),
     InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IEdgeElevator2FinalB
    {
        [PreserveSig] int Placeholder1();
        [PreserveSig] int Placeholder2();
        [PreserveSig] int Placeholder3();
        [PreserveSig] int RunRecoveryCRXElevated(
            [MarshalAs(UnmanagedType.LPWStr)] string crx_path,
            [MarshalAs(UnmanagedType.LPWStr)] string browser_appid,
            [MarshalAs(UnmanagedType.LPWStr)] string browser_version,
            [MarshalAs(UnmanagedType.LPWStr)] string session_id,
            uint caller_proc_id, out IntPtr proc_handle);
        [PreserveSig] int EncryptData(int protection_level,
            [MarshalAs(UnmanagedType.BStr)] string plaintext,
            out IntPtr ciphertext, out int last_error);
        [PreserveSig] int DecryptData(
            IntPtr ciphertext,
            out IntPtr plaintext, out int last_error);
    }

    static class Program
    {
        private static readonly Guid ClsidEdgeElevator =
            new Guid("1FCBE96C-1697-43AF-9140-2897C7C69767");

        [DllImport("oleaut32.dll")]
        private static extern IntPtr SysAllocStringByteLen(string psz, uint len);

        [DllImport("oleaut32.dll")]
        private static extern void SysFreeString(IntPtr bstr);

        private static object _elevator;
        private static bool _useFallbackIid;

        private static object GetElevator()
        {
            if (_elevator != null) return _elevator;
            Type type = Type.GetTypeFromCLSID(ClsidEdgeElevator);
            if (type == null)
                throw new Exception("无法从 CLSID 创建 elevation_service 类型");
            object raw = Activator.CreateInstance(type);
            if (!_useFallbackIid)
            {
                IEdgeElevator2Final a = (IEdgeElevator2Final)raw;
                _elevator = a;
            }
            else
            {
                IEdgeElevator2FinalB b = (IEdgeElevator2FinalB)raw;
                _elevator = b;
            }
            return _elevator;
        }

        /// <summary>调用 DecryptData；IID 不符时自动切换备选接口重试一次。</summary>
        private static string Decrypt(string base64Cipher)
        {
            int hr;
            string plaintextB64 = null;
            int lastError = 0;
            byte[] cipherBytes;
            try
            {
                cipherBytes = Convert.FromBase64String(base64Cipher);
            }
            catch (Exception ex)
            {
                throw new Exception("base64 解码失败: " + ex.Message);
            }

            // ciphertext 是「字节 BSTR」：必须承载 base64 解码后的原始二进制，
            // 不能直接传字符串（服务端按原始字节解析，传字符串会得到 ERROR_INVALID_DATA）。
            IntPtr cipherBstr = IntPtr.Zero;
            IntPtr pText = IntPtr.Zero;
            try
            {
                cipherBstr = SysAllocStringByteLen(null, (uint)cipherBytes.Length);
                if (cipherBstr == IntPtr.Zero) throw new Exception("SysAllocStringByteLen 失败");
                Marshal.Copy(cipherBytes, 0, cipherBstr, cipherBytes.Length);

                object e = GetElevator();
                if (e is IEdgeElevator2Final)
                {
                    hr = ((IEdgeElevator2Final)e).DecryptData(cipherBstr, out pText, out lastError);
                }
                else
                {
                    hr = ((IEdgeElevator2FinalB)e).DecryptData(cipherBstr, out pText, out lastError);
                }
                if (hr == 0)
                {
                    if (pText == IntPtr.Zero) throw new Exception("DecryptData 返回空");
                    int len = Marshal.ReadInt32(pText, -4);
                    if (len < 0) len = 0;
                    byte[] plain = new byte[len];
                    if (len > 0) Marshal.Copy(pText, plain, 0, len);
                    plaintextB64 = Convert.ToBase64String(plain);
                }
            }
            catch (InvalidCastException)
            {
                if (!_useFallbackIid)
                {
                    _useFallbackIid = true;
                    _elevator = null;
                    return Decrypt(base64Cipher); // 备选 IID 重试一次
                }
                throw;
            }
            finally
            {
                if (cipherBstr != IntPtr.Zero) SysFreeString(cipherBstr);
                if (pText != IntPtr.Zero) SysFreeString(pText);
            }
            if (hr != 0)
            {
                throw new Exception(string.Format(
                    "DecryptData 失败 HRESULT=0x{0:X8} lastError={1}",
                    hr, lastError));
            }
            if (plaintextB64 == null) throw new Exception("DecryptData 返回空");
            return plaintextB64; // base64 明文
        }

        private static string BytesToHex(byte[] bytes)
        {
            StringBuilder sb = new StringBuilder(bytes.Length * 2);
            foreach (byte b in bytes) sb.Append(b.ToString("x2"));
            return sb.ToString();
        }

        private static int Main(string[] args)
        {
            try
            {
                if (args.Length < 1)
                {
                    Console.Error.WriteLine("usage: decrypt-key|decrypt-value|decrypt-values");
                    return 2;
                }
                string mode = args[0].ToLowerInvariant();
                if (mode == "decrypt-key")
                {
                    if (args.Length < 2)
                    {
                        Console.Error.WriteLine("decrypt-key 缺少 base64 参数");
                        return 2;
                    }
                    string b64Out = Decrypt(args[1]); // base64 的 32B 明文
                    byte[] key = Convert.FromBase64String(b64Out);
                    if (key.Length != 32)
                    {
                        Console.Error.WriteLine(string.Format(
                            "解密出的 key 长度异常: {0} (期望 32)", key.Length));
                        return 3;
                    }
                    Console.Out.WriteLine("OK:" + BytesToHex(key));
                    return 0;
                }
                if (mode == "decrypt-value")
                {
                    if (args.Length < 2)
                    {
                        Console.Error.WriteLine("decrypt-value 缺少 base64 参数");
                        return 2;
                    }
                    string b64Out = Decrypt(args[1]);
                    Console.Out.WriteLine("OK:" + b64Out);
                    return 0;
                }
                if (mode == "decrypt-values")
                {
                    string line;
                    while ((line = Console.In.ReadLine()) != null)
                    {
                        line = line.Trim();
                        if (line.Length == 0) { Console.Out.WriteLine("ERR:EMPTY"); continue; }
                        try
                        {
                            Console.Out.WriteLine("OK:" + Decrypt(line));
                        }
                        catch (Exception ex)
                        {
                            Console.Out.WriteLine("ERR:" + ex.Message.Replace("\r", " ").Replace("\n", " "));
                        }
                    }
                    return 0;
                }
                Console.Error.WriteLine("未知模式: " + mode);
                return 2;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine("FATAL:" + ex.Message);
                return 1;
            }
        }
    }
}
